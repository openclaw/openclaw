// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import type { MessageClientSource } from "../../../../src/chat/message-client-source.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";
import {
  assistantGroupCanOwnActiveRunStatus,
  collapseCompletedTurnWork,
  coalesceActivityRuns,
  groupMessages,
} from "./chat-thread-grouping.ts";
import { createProps } from "./chat-thread.test-support.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

const sessionKey = "agent:main:dashboard:answers";
const cli: MessageClientSource = { id: "cli", mode: "cli", displayName: "Release helper" };
const web: MessageClientSource = { id: "openclaw-control-ui", mode: "webchat" };
function message(role: string, content: unknown, timestamp: number, extra: object = {}) {
  return { role, content, timestamp, ...extra };
}
function forwarded(
  senderSession: { sessionKey: string; agentId: string; label?: string },
  content = "Report",
) {
  return message("assistant", content, 1, { senderLabel: "Forwarded from main", senderSession });
}
function cachedGroups(messages: unknown[]) {
  return buildCachedChatItems(createProps({ messages })).filter((item) => item.kind === "group");
}
function collapse(messages: unknown[]) {
  return collapseCompletedTurnWork(cachedGroups(messages), { sessionKey, runWorking: false });
}
function projected(messages: unknown[]) {
  return coalesceAgentRunFrames(coalesceActivityRuns(collapse(messages))).flatMap((item) =>
    item.kind === "agent-run-frame" ? item.parts : [item],
  );
}
function visible(items: ReturnType<typeof projected>) {
  return items.flatMap((item) =>
    item.kind === "group" ? item.messages.map((source) => source.message) : [],
  );
}
function work(items: ReturnType<typeof projected>) {
  return items
    .filter((item) => item.kind === "work-group")
    .flatMap((item) =>
      item.groups.flatMap((group) => group.messages.map((source) => source.message)),
    );
}
function tool(id: string, timestamp: number, extra: object = {}) {
  return message("toolResult", "Evidence", timestamp, {
    toolCallId: id,
    toolName: "read",
    ...extra,
  });
}
function signed(text: string, phase: string) {
  return { type: "text", text, textSignature: JSON.stringify({ v: 1, id: text, phase }) };
}
beforeEach(() => resetChatThreadState());

describe("queued input group continuity", () => {
  it("keeps each queued message in the same row through acceptance and persistence", () => {
    const queue: ChatQueueItem[] = ["First queued input", "Second queued input"].map(
      (text, index) => ({
        id: `local-${index}`,
        text,
        createdAt: index + 1,
        sendRunId: `send-${index}`,
        sendState: "waiting-reconnect",
        sendAttempts: 1,
      }),
    );
    const pendingInputs = queue.map((item, index) => ({
      id: `accepted-${index}`,
      runId: item.sendRunId,
      state: "queued" as const,
      acceptedAt: index + 1,
      message: {
        role: "user",
        content: item.text,
        timestamp: index + 1,
        __openclaw: { id: `pending:accepted-${index}` },
      },
    }));
    const persisted = queue.map((item, index) => ({
      role: "user",
      content: item.text,
      timestamp: index + 1,
      __openclaw: {
        id: `persisted-${index}`,
        seq: index + 1,
        idempotencyKey: `${item.sendRunId}:user`,
        runId: `execution-${index}`,
      },
    }));
    const render = (
      input: Pick<Parameters<typeof buildCachedChatItems>[0], "messages" | "pendingInputs">,
    ) =>
      buildCachedChatItems(
        createProps({
          paneId: "queued-input-continuity",
          sessionKey: "agent:main:dashboard:queued-inputs",
          queue,
          ...input,
        }),
      ).filter((item) => item.kind === "group");
    const initial = render({ messages: [] });
    const rowKeys = initial.map((group) => group.key);
    const messageKeys = initial.map((group) => group.messages[0]?.key);

    expect(initial.map((group) => group.messages.length)).toEqual([1, 1]);
    for (const input of [
      { messages: [], pendingInputs: pendingInputs.slice(0, 1) },
      { messages: [], pendingInputs },
      { messages: persisted.slice(0, 1), pendingInputs: pendingInputs.slice(1) },
      { messages: persisted, pendingInputs: [] },
    ]) {
      const groups = render(input);
      expect(groups.map((group) => group.key)).toEqual(rowKeys);
      expect(groups.map((group) => group.messages.length)).toEqual([1, 1]);
      expect(groups.map((group) => group.messages[0]?.key)).toEqual(messageKeys);
    }
  });
});

describe("source attribution", () => {
  it.each([
    { source: "different clients", next: [web], text: "Continue", split: true },
    {
      source: "different app labels",
      next: [{ ...cli, displayName: "Deploy helper" }],
      text: "Continue",
      split: true,
    },
    { source: "collected sources", next: [cli, web], text: "Continue", split: true },
    { source: "the same collected sources", next: [cli, web], text: "Next turn", split: false },
  ])("groups messages from $source without losing provenance", ({ next, text, split }) => {
    const clients = split ? [cli] : [cli, web];
    const from = (sourceClients: MessageClientSource[], content: string) =>
      message("user", content, 1, {
        __openclaw: {
          senderId: "same-person",
          senderIdentity: { type: "profile", id: "same-person" },
          transport: { clients: sourceClients },
        },
      });
    const groups = cachedGroups([from(clients, "Continue"), from(next, text)]);
    expect(groups.map((group) => group.sourceClients)).toEqual(split ? [clients, next] : [clients]);
    expect(groups.map((group) => group.messages.length)).toEqual(split ? [1, 1] : [2]);
    expect(groups.map((group) => group.sender?.identity)).toEqual(
      Array.from({ length: split ? 2 : 1 }, () => ({ type: "profile", id: "same-person" })),
    );
    expect(groups.flatMap((group) => group.messages).map((entry) => entry.duplicateCount)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it.each([
    {
      change: "client",
      before: message("user", "Continue", 1, { __openclaw: { transport: { clients: [cli] } } }),
      after: message("user", "Continue", 1, { __openclaw: { transport: { clients: [web] } } }),
      previous: { sourceClients: [cli] },
      expected: { sourceClients: [web] },
    },
    ...[
      { sessionKey: "agent:main:dashboard:other", agentId: "main" },
      { sessionKey: "agent:main:main", agentId: "updated" },
      { sessionKey: "agent:main:main", agentId: "main", label: "Automation name" },
    ].map((senderSession) => ({
      change: JSON.stringify(senderSession),
      before: forwarded({ sessionKey: "agent:main:main", agentId: "main" }),
      after: forwarded(senderSession),
      previous: { senderSession: { sessionKey: "agent:main:main", agentId: "main" } },
      expected: { senderSession },
    })),
    ...["Renamed report", undefined].map((label) => {
      const senderSession = {
        sessionKey: "agent:main:cron:daily:run:first",
        agentId: "main",
        label: "Daily report",
      };
      return {
        change: `label ${label}`,
        before: forwarded(senderSession),
        after: forwarded({ ...senderSession, label }),
        previous: { senderSession },
        expected: { senderSession: { ...senderSession, label } },
      };
    }),
  ])(
    "refreshes cached source attribution after $change",
    ({ before, after, previous, expected }) => {
      const initial = cachedGroups([before]);
      const refreshed = cachedGroups([after]);
      for (const [actual, fields] of [
        [initial[0], previous],
        [refreshed[0], expected],
      ] as const) {
        if ("senderSession" in fields) {
          expect(actual?.senderSession).toEqual(fields.senderSession);
        } else {
          expect(actual?.sourceClients).toEqual(fields.sourceClients);
        }
      }
      expect(refreshed[0]).not.toBe(initial[0]);
    },
  );

  it.each([
    {
      name: "same source",
      next: "agent:main:main",
      text: "Second report",
      labels: [undefined, undefined],
      split: false,
    },
    {
      name: "different source",
      next: "agent:main:dashboard:other",
      text: "Second report",
      labels: [undefined, undefined],
      split: true,
    },
    {
      name: "identical reports from different sources",
      next: "agent:main:dashboard:other",
      text: "Report",
      labels: [undefined, undefined],
      split: true,
    },
    {
      name: "renamed automation",
      next: "agent:main:main",
      text: "Report",
      labels: ["Daily report", "Renamed report"],
      split: true,
    },
  ])("preserves forwarded provenance for $name", ({ next, text, labels, split }) => {
    const first = labels[0] ? "agent:main:cron:daily:run:first" : "agent:main:main";
    const sources = [first, labels[0] ? first : next].map((key, index) => ({
      sessionKey: key,
      agentId: "main",
      label: labels[index],
    }));
    const messages = sources.map((source, index) => forwarded(source, index ? text : "Report"));
    const groups = cachedGroups(messages);
    expect(groups.map((group) => group.senderSession)).toEqual(split ? sources : [sources[0]]);
    expect(groups.map((group) => group.senderLabel)).toEqual(
      split ? ["Forwarded from main", "Forwarded from main"] : ["Forwarded from main"],
    );
    expect(groups.map((group) => group.messages.map((source) => source.message))).toEqual(
      split ? messages.map((entry) => [entry]) : [messages],
    );
    expect(groups.flatMap((group) => group.messages).map((entry) => entry.duplicateCount)).toEqual([
      undefined,
      undefined,
    ]);
  });
});

describe("content classification", () => {
  it.each([
    { type: "text", text: "Visible answer" },
    { type: "image", source: { type: "url", url: "https://example.com/result.png" } },
    {
      type: "attachment",
      attachment: { kind: "document", url: "https://example.com/result.pdf", label: "Result" },
    },
    {
      type: "canvas",
      preview: {
        kind: "canvas",
        surface: "assistant_message",
        render: "url",
        url: "https://example.com/result",
      },
    },
    { type: "future-visible-block" },
  ])("keeps mixed reasoning and $type visible", (outcome) => {
    const thinking = { type: "thinking", thinking: "Checking the evidence." };
    const messages = [
      message("user", "Check it.", 1000),
      message("assistant", [thinking], 2000),
      message("assistant", [thinking, outcome], 3000),
    ];
    const groups = groupMessages(
      messages.map((entry, index) => ({
        kind: "message",
        key: `message:${index}`,
        message: entry,
      })),
    );
    expect(collapseCompletedTurnWork(groups, { sessionKey, runWorking: false })).toMatchObject([
      { kind: "group", role: "user" },
      { kind: "work-group", groups: [{ messages: [{ message: messages[1] }] }] },
      { kind: "group", messages: [{ message: messages[2] }] },
    ]);
    const reasoning = groups[1];
    expect(reasoning?.kind).toBe("group");
    if (reasoning?.kind === "group") {
      expect(assistantGroupCanOwnActiveRunStatus(reasoning)).toBe(false);
    }
  });

  it.each(["user", "assistant", "toolResult"])("preserves malformed %s content", (role) => {
    for (const content of [[null], [null, { type: "text", text: "Still visible" }]]) {
      const entry = { role, content };
      expect(groupMessages([{ kind: "message", key: "malformed", message: entry }])).toMatchObject([
        { kind: "group", messages: [{ key: "malformed", message: entry }] },
      ]);
    }
  });

  it("keeps media visible and folds commentary after replacement", () => {
    const preview = message(
      "assistant",
      [{ type: "image", url: "https://example.com/diagram.png" }],
      2,
    );
    const messages = [
      message("user", "Build a diagram", 1),
      preview,
      tool("render-diagram", 3),
      message("assistant", "Done", 4),
    ];
    expect(collapse(messages)).toMatchObject([
      { kind: "group", role: "user" },
      { kind: "work-group", groups: [{ role: "tool" }] },
      { kind: "group", role: "assistant", messages: [{ message: preview }] },
      { kind: "group", role: "assistant" },
    ]);
    const replacement = { ...preview, content: [{ type: "text", text: "Preparing a diagram" }] };
    expect(
      collapse(messages.map((entry) => (entry === preview ? replacement : entry))),
    ).toMatchObject([
      { kind: "group", role: "user" },
      {
        kind: "work-group",
        groups: [{ role: "assistant", messages: [{ message: replacement }] }, { role: "tool" }],
      },
      { kind: "group", role: "assistant" },
    ]);
  });
});

describe("answer visibility across continuations", () => {
  const terminalCases = [
    { name: "settled terminal", terminal: true, preserved: true },
    { name: "intermediate text", terminal: false, preserved: false },
    { name: "explicit commentary", terminal: true, phase: "commentary", preserved: false },
    { name: "interrupted text", terminal: true, aborted: true, preserved: false },
    { name: "legacy unphased reply", terminal: true, legacy: true, preserved: false },
  ].map(({ name, terminal, phase, aborted, legacy, preserved }) => {
    const run = { runId: "completed-run" };
    const messages = [
      message("user", "Inspect the file", 1, { __openclaw: run }),
      tool("read-file", 2, { __openclaw: run }),
      message("assistant", "File verified — café 雪 🦞", 3, {
        stopReason: "stop",
        ...(phase ? { phase } : {}),
        ...(aborted ? { openclawAbort: { aborted: true } } : {}),
        __openclaw: {
          ...run,
          ...(!legacy ? { mirrorOrigin: "codex-app-server", runTerminal: terminal } : {}),
        },
      }),
      message("assistant", "Gateway restart config-patch ok", 4, {
        api: "openclaw-transcript",
        provider: "openclaw",
        model: "delivery-mirror",
        stopReason: "stop",
      }),
    ];
    return {
      name,
      messages,
      shown: [messages[0], ...(preserved ? [messages[2]] : []), messages[3]],
      folded: [messages[1], ...(!preserved ? [messages[2]] : [])],
    };
  });
  const signedCases = [
    { phase: "final_answer", withTool: true, mixed: false },
    { phase: "final_answer", withTool: false, mixed: false },
    { phase: "commentary", withTool: true, mixed: false },
    { phase: "commentary", withTool: false, mixed: false },
    { phase: "final_answer", withTool: true, mixed: true },
  ].map(({ phase, withTool, mixed }) => {
    const run = { __openclaw: { runId: "run" } };
    const first = message("user", "Investigate", 1, run);
    const answer = message(
      "assistant",
      [
        ...(mixed ? [signed("Checking", "commentary")] : []),
        signed("Substantive answer", "final_answer"),
      ],
      2,
      run,
    );
    const evidence = withTool ? [tool("call", 3, run)] : [];
    const later = message("assistant", [signed("Later update", phase)], 4, run);
    return {
      name: `${mixed ? "mixed" : "signed"} answer before ${phase}, tool=${withTool}`,
      messages: [first, answer, ...evidence, later],
      shown: [first, answer, ...(phase === "final_answer" ? [later] : [])],
      folded: [...evidence, ...(phase === "commentary" ? [later] : [])],
    };
  });
  it.each([...terminalCases, ...signedCases])(
    "preserves $name through history reload",
    ({ messages, shown, folded }) => {
      for (const history of [messages, structuredClone(messages)]) {
        const items = projected(history);
        expect(visible(items)).toEqual(shown);
        expect(work(items)).toEqual(folded);
        expect(items.filter((item) => item.kind === "work-group")).toHaveLength(
          folded.length ? 1 : 0,
        );
        if (folded.length) {
          expect(items[1]?.kind).toBe("work-group");
        }
      }
    },
  );

  it.each(["same-run", "independent-run", "unscoped"])(
    "keeps %s trailing activity with its owner",
    (ownership) => {
      const messages = [
        message("user", "Watch the queue", 1),
        message("assistant", "Checking", 2, { phase: "commentary", runId: "reply" }),
        message("assistant", "Watching", 3, { phase: "final_answer", runId: "reply" }),
        ...[1, 2].flatMap((index) => {
          const runId =
            ownership === "unscoped"
              ? undefined
              : ownership === "same-run"
                ? "reply"
                : `wake-${index}`;
          return [
            message(
              "assistant",
              [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: {} }],
              4 * index,
              { runId },
            ),
            tool(`call-${index}`, 4 * index + 1, { runId }),
          ];
        }),
      ];
      for (const history of [messages, structuredClone(messages)]) {
        const groups = groupMessages(
          history.map((entry, index) => ({
            kind: "message",
            key: `message:${index}`,
            message: entry,
          })),
        );
        const items = coalesceActivityRuns(
          collapseCompletedTurnWork(groups, { sessionKey, runWorking: false }),
        );
        const independent = ownership === "independent-run";
        expect(items.map((item) => item.kind)).toEqual(
          independent
            ? ["group", "work-group", "group", "activity-run"]
            : ["group", "work-group", "group"],
        );
        expect(work(items)).toEqual(
          independent ? [messages[1]] : [messages[1], ...messages.slice(3)],
        );
        if (independent) {
          expect(items.find((item) => item.kind === "work-group")?.durationMs).toBeNull();
        }
        expect(
          items
            .filter((item) => item.kind === "activity-run")
            .flatMap((item) =>
              item.groups.flatMap((group) => group.messages.map((source) => source.message)),
            ),
        ).toEqual(independent ? messages.slice(3) : []);
      }
    },
  );

  it("collects activity around answers without crossing the next user or mutating history", () => {
    const messages = [
      message("user", "First question", 1),
      message("assistant", "Checking first", 2, { phase: "commentary" }),
      message("assistant", "First answer", 3, { phase: "final_answer" }),
      tool("first", 4),
      message("assistant", "Addendum", 5, { phase: "final_answer" }),
      message("assistant", "Final check", 6, { phase: "commentary" }),
      tool("last", 7),
      message("user", "Second question", 8),
      message("assistant", "Checking second", 9, { phase: "commentary" }),
      message("assistant", "Second answer", 10, { phase: "final_answer" }),
    ];
    const snapshot = structuredClone(messages);
    const items = collapse(messages);
    expect(items.map((item) => item.kind)).toEqual([
      "group",
      "work-group",
      "group",
      "group",
      "group",
      "work-group",
      "group",
    ]);
    const folded = items.filter((item) => item.kind === "work-group");
    expect(
      folded.map((item) =>
        item.groups.flatMap((group) => group.messages.map((source) => source.message)),
      ),
    ).toEqual([[messages[1], messages[3], messages[5], messages[6]], [messages[8]]]);
    expect(folded[0]?.durationMs).toBeNull();
    expect(visible(items)).toEqual([
      messages[0],
      messages[2],
      messages[4],
      messages[7],
      messages[9],
    ]);
    expect(messages).toEqual(snapshot);
  });
});
