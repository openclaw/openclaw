// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import type { MessageClientSource } from "../../../../src/chat/message-client-source.js";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";
import {
  assistantGroupCanOwnActiveRunStatus,
  collapseCompletedTurnWork,
  coalesceActivityRuns,
  groupMessages,
} from "./chat-thread-grouping.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

function forwardedMessage(sessionKey: string, content = "Forwarded report") {
  return {
    role: "assistant",
    content,
    timestamp: 1,
    senderLabel: "Forwarded from main",
    senderSession: { sessionKey, agentId: "main" },
  };
}

function cachedGroups(messages: unknown[]) {
  return buildCachedChatItems({
    paneId: "forwarded-attribution",
    sessionKey: "agent:target:main",
    messages,
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
  }).filter((item) => item.kind === "group");
}

describe("message client attribution", () => {
  beforeEach(() => resetChatThreadState());

  const cli: MessageClientSource = { id: "cli", mode: "cli", displayName: "Release helper" };
  const web: MessageClientSource = { id: "openclaw-control-ui", mode: "webchat" };
  const messageFrom = (clients: MessageClientSource[], content = "Continue the task.") => ({
    role: "user",
    content,
    timestamp: 1,
    __openclaw: {
      senderId: "same-person",
      senderIdentity: { type: "profile", id: "same-person" },
      transport: { clients },
    },
  });

  it.each([
    { source: "different clients", next: [web] },
    { source: "different app labels", next: [{ ...cli, displayName: "Deploy helper" }] },
    { source: "a collected source list", next: [cli, web] },
  ])("keeps identical messages from $source separate for the same human", ({ next }) => {
    const groups = cachedGroups([messageFrom([cli]), messageFrom(next)]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.sourceClients)).toEqual([[cli], next]);
    expect(groups.map((group) => group.sender?.identity)).toEqual([
      { type: "profile", id: "same-person" },
      { type: "profile", id: "same-person" },
    ]);
    expect(groups.flatMap((group) => group.messages).map((entry) => entry.duplicateCount)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("groups different text from the same client and keeps all collected client labels", () => {
    const clients = [cli, web];
    const groups = cachedGroups([
      messageFrom(clients, "First collected turn."),
      messageFrom(clients, "Second collected turn."),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.sourceClients).toEqual(clients);
    expect(groups[0]?.messages).toHaveLength(2);
  });

  it("refreshes cached source attribution after an in-place history projection changes", () => {
    const message = messageFrom([cli]);
    const initial = cachedGroups([message]);
    message["__openclaw"].transport.clients = [web];
    const refreshed = cachedGroups([message]);
    expect(initial[0]?.sourceClients).toEqual([cli]);
    expect(refreshed[0]?.sourceClients).toEqual([web]);
    expect(refreshed[0]).not.toBe(initial[0]);
  });
});

describe("reasoning activity boundaries", () => {
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
  ])("preserves mixed reasoning and $type as the visible outcome", (outcome) => {
    const thinking = { type: "thinking", thinking: "Checking the evidence." };
    const messages = [
      { role: "user", content: "Check it.", timestamp: 1_000 },
      { role: "assistant", content: [thinking], timestamp: 2_000 },
      { role: "assistant", content: [thinking, outcome], timestamp: 3_000 },
    ];
    const groups = groupMessages(
      messages.map((message, index) => ({
        kind: "message",
        key: `message:${index}`,
        message,
      })),
    );
    expect(
      collapseCompletedTurnWork(groups, {
        sessionKey: "agent:main:dashboard:reasoning",
        runWorking: false,
      }),
    ).toMatchObject([
      { kind: "group", role: "user" },
      { kind: "work-group", groups: [{ messages: [{ message: messages[1] }] }] },
      { kind: "group", messages: [{ message: messages[2] }] },
    ]);
    const reasoningGroup = groups[1];
    expect(reasoningGroup?.kind).toBe("group");
    if (reasoningGroup?.kind === "group") {
      expect(assistantGroupCanOwnActiveRunStatus(reasoningGroup)).toBe(false);
    }
  });
});

describe("forwarded source-session grouping", () => {
  beforeEach(() => resetChatThreadState());

  it("carries the first message's source session while grouping messages from that source", () => {
    const messages = [
      forwardedMessage("agent:main:main", "First report"),
      forwardedMessage("agent:main:main", "Second report"),
    ];
    const items: ChatItem[] = messages.map((message, index) => ({
      kind: "message",
      key: `message:${index}`,
      message,
    }));

    expect(groupMessages(items)).toMatchObject([
      {
        senderLabel: "Forwarded from main",
        senderSession: { sessionKey: "agent:main:main", agentId: "main" },
        messages: [{ message: messages[0] }, { message: messages[1] }],
      },
    ]);
  });

  it("splits messages from different source sessions even when the agent labels match", () => {
    const items: ChatItem[] = ["agent:main:main", "agent:main:dashboard:other"].map(
      (sessionKey, index) => ({
        kind: "message",
        key: `message:${index}`,
        message: forwardedMessage(sessionKey, `Report ${index}`),
      }),
    );

    const groups = groupMessages(items);
    expect(groups).toHaveLength(2);
    expect(groups).toMatchObject([
      { senderSession: { sessionKey: "agent:main:main" } },
      { senderSession: { sessionKey: "agent:main:dashboard:other" } },
    ]);
  });

  it("does not collapse identical reports from different source sessions before grouping", () => {
    const groups = cachedGroups([
      forwardedMessage("agent:main:main"),
      forwardedMessage("agent:main:dashboard:other"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.messages.length === 1)).toBe(true);
    expect(groups.flatMap((group) => group.messages).map((entry) => entry.duplicateCount)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("keeps distinct automation labels on identical reports from the same source session", () => {
    const groups = cachedGroups(
      ["Daily report", "Renamed report"].map((label) =>
        Object.assign(forwardedMessage("agent:main:cron:daily:run:first"), {
          senderSession: { sessionKey: "agent:main:cron:daily:run:first", agentId: "main", label },
        }),
      ),
    );

    expect(groups.map((group) => group.senderSession?.label)).toEqual([
      "Daily report",
      "Renamed report",
    ]);
    expect(groups.flatMap((group) => group.messages).map((entry) => entry.duplicateCount)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it.each([
    { senderSession: { sessionKey: "agent:main:main", agentId: "main" } },
    { provenance: { kind: "inter_session", sourceTool: "sessions_send" } },
  ])("clears stale human reply attribution at a forwarded boundary %o", (attribution) => {
    const groups = cachedGroups([
      { role: "user", content: "Alice's question", __openclaw: { senderId: "alice" } },
      { role: "user", content: "Bob's question", __openclaw: { senderId: "bob" } },
      { role: "assistant", content: "Answer for Bob" },
      {
        role: "assistant",
        content: "Forwarded report",
        senderLabel: "Forwarded from main",
        ...attribution,
      },
      { role: "assistant", content: "Response to the forwarded report" },
    ]);

    expect(groups).toHaveLength(5);
    expect(groups[2]?.replyToSender).toEqual({ id: "bob" });
    expect(groups[3]?.replyToSender).toBeUndefined();
    expect(groups[4]?.replyToSender).toBeUndefined();
  });

  it.each([
    { sessionKey: "agent:main:dashboard:other", agentId: "main" },
    { sessionKey: "agent:main:main", agentId: "updated" },
    { sessionKey: "agent:main:main", agentId: "main", label: "Automation name" },
  ])("refreshes cached attribution when the source changes to %o", (senderSession) => {
    const message = forwardedMessage("agent:main:main");
    const initial = cachedGroups([message]);
    message.senderSession = senderSession;

    const refreshed = cachedGroups([message]);

    expect(refreshed[0]?.senderSession).toEqual(senderSession);
    expect(refreshed[0]).not.toBe(initial[0]);
  });

  it.each(["Renamed report", undefined])(
    "refreshes the displayed automation label after a rename or removal: %s",
    (label) => {
      const senderSession: { sessionKey: string; agentId: string; label?: string } = {
        sessionKey: "agent:main:cron:daily:run:first",
        agentId: "main",
        label: "Daily report",
      };
      const message = {
        ...forwardedMessage("agent:main:cron:daily:run:first"),
        senderSession,
      };
      const initial = cachedGroups([message]);
      expect(initial[0]?.senderSession?.label).toBe("Daily report");

      message.senderSession.label = label;
      const refreshed = cachedGroups([message]);

      expect(refreshed[0]?.senderSession?.label).toBe(label);
      expect(refreshed[0]).not.toBe(initial[0]);
    },
  );
});

describe("cached group content classification", () => {
  beforeEach(() => resetChatThreadState());

  it.each(["user", "assistant", "toolResult"])(
    "preserves %s messages when normalization skips malformed content blocks",
    (role) => {
      for (const content of [[null], [null, { type: "text", text: "Still visible" }]]) {
        const message = { role, content };
        expect(groupMessages([{ kind: "message", key: "malformed", message }])).toMatchObject([
          { kind: "group", messages: [{ key: "malformed", message }] },
        ]);
      }
    },
  );

  it("keeps media visible and folds commentary after the same message changes in place", () => {
    const content: Record<string, unknown>[] = [
      { type: "image", url: "https://example.com/diagram.png" },
    ];
    const preview = {
      role: "assistant",
      content,
      timestamp: 2,
    };
    const messages = [
      { role: "user", content: "Build a diagram", timestamp: 1 },
      preview,
      {
        role: "toolResult",
        toolCallId: "render-diagram",
        toolName: "render",
        content: "Ready",
        timestamp: 3,
      },
      { role: "assistant", content: "Done", timestamp: 4 },
    ];
    const project = () =>
      collapseCompletedTurnWork(cachedGroups([...messages]), {
        sessionKey: "agent:target:dashboard:history",
        runWorking: false,
      });

    expect(project()).toMatchObject([
      { kind: "group", role: "user" },
      { kind: "work-group", groups: [{ role: "tool" }] },
      { kind: "group", role: "assistant", messages: [{ message: preview }] },
      { kind: "group", role: "assistant" },
    ]);

    preview.content.splice(0, 1, { type: "text", text: "Preparing a diagram" });

    expect(project()).toMatchObject([
      { kind: "group", role: "user" },
      {
        kind: "work-group",
        groups: [{ role: "assistant", messages: [{ message: preview }] }, { role: "tool" }],
      },
      { kind: "group", role: "assistant" },
    ]);
  });
});

describe("explicit answer visibility across continuations", () => {
  beforeEach(() => resetChatThreadState());

  it.each([
    { name: "settled Codex answer", terminal: true, preserved: true },
    { name: "intermediate Codex text", terminal: false, preserved: false },
    { name: "explicit commentary", terminal: true, phase: "commentary", preserved: false },
    { name: "interrupted Codex text", terminal: true, aborted: true, preserved: false },
    { name: "legacy unphased reply", terminal: true, legacy: true, preserved: false },
  ])(
    "classifies $name before an unscoped delivery notice",
    ({ terminal, phase, aborted, legacy, preserved }) => {
      const runId = "completed-run";
      const messages = [
        { role: "user", content: "Inspect the file", timestamp: 1, __openclaw: { runId } },
        {
          role: "toolResult",
          toolCallId: "read-file",
          toolName: "exec",
          content: "File inspected",
          timestamp: 2,
          __openclaw: { runId },
        },
        {
          role: "assistant",
          content: "File verified — café 雪 🦞",
          stopReason: "stop",
          ...(phase ? { phase } : {}),
          ...(aborted ? { openclawAbort: { aborted: true } } : {}),
          timestamp: 3,
          __openclaw: {
            runId,
            ...(!legacy ? { mirrorOrigin: "codex-app-server", runTerminal: terminal } : {}),
          },
        },
        {
          role: "assistant",
          content: "Gateway restart config-patch ok",
          api: "openclaw-transcript",
          provider: "openclaw",
          model: "delivery-mirror",
          stopReason: "stop",
          timestamp: 4,
        },
      ];
      for (const history of [messages, structuredClone(messages)]) {
        const items = coalesceAgentRunFrames(
          coalesceActivityRuns(
            collapseCompletedTurnWork(cachedGroups(history), {
              sessionKey: "agent:main:dashboard:answers",
              runWorking: false,
            }),
          ),
        );
        const parts = items.flatMap((item) =>
          item.kind === "agent-run-frame" ? item.parts : [item],
        );
        expect(
          parts
            .filter((item) => item.kind === "group")
            .flatMap((item) => item.messages.map(({ message }) => message)),
        ).toEqual([messages[0], ...(preserved ? [messages[2]] : []), messages[3]]);
        expect(
          parts
            .filter((item) => item.kind === "work-group")
            .flatMap((item) =>
              item.groups.flatMap((group) => group.messages.map(({ message }) => message)),
            ),
        ).toEqual([messages[1], ...(!preserved ? [messages[2]] : [])]);
      }
    },
  );

  it.each([
    { phase: "final_answer", tool: true },
    { phase: "final_answer", tool: false },
    { phase: "commentary", tool: true },
    { phase: "commentary", tool: false },
  ] as const)(
    "preserves an answer before $phase with intervening tool=$tool",
    ({ phase, tool }) => {
      const signed = (text: string, messagePhase: string) => ({
        type: "text",
        text,
        textSignature: JSON.stringify({ v: 1, id: text, phase: messagePhase }),
      });
      const messages = [
        { role: "user", content: "Investigate", timestamp: 1, __openclaw: { runId: "run" } },
        {
          role: "assistant",
          content: [signed("Substantive answer", "final_answer")],
          timestamp: 2,
          __openclaw: { runId: "run" },
        },
        ...(tool
          ? [
              {
                role: "toolResult",
                toolCallId: "call",
                toolName: "read",
                content: "Evidence",
                timestamp: 3,
                __openclaw: { runId: "run" },
              },
            ]
          : []),
        {
          role: "assistant",
          content: [signed("Later update", phase)],
          timestamp: 4,
          __openclaw: { runId: "run" },
        },
      ];
      // Exercise the renderer's complete grouping pipeline, including a history reload.
      for (const history of [messages, structuredClone(messages)]) {
        const items = coalesceAgentRunFrames(
          coalesceActivityRuns(
            collapseCompletedTurnWork(cachedGroups(history), {
              sessionKey: "agent:main:dashboard:answers",
              runWorking: false,
            }),
          ),
        );
        const parts = items.flatMap((item) =>
          item.kind === "agent-run-frame" ? item.parts : [item],
        );
        const visible = parts.flatMap((item) =>
          item.kind === "group" ? item.messages.map(({ message }) => message) : [],
        );
        expect(visible).toContainEqual(messages[1]);
        if (phase === "final_answer") {
          expect(visible).toContainEqual(messages.at(-1));
        } else {
          expect(visible).not.toContainEqual(messages.at(-1));
        }
        const work = parts.filter((item) => item.kind === "work-group");
        const expectedWork = [
          ...(tool ? [messages[2]] : []),
          ...(phase === "commentary" ? [messages.at(-1)] : []),
        ];
        expect(
          work.flatMap((item) =>
            item.groups.flatMap((group) => group.messages.map(({ message }) => message)),
          ),
        ).toEqual(expectedWork);
        expect(work).toHaveLength(expectedWork.length ? 1 : 0);
        if (expectedWork.length) {
          expect(parts[1]?.kind).toBe("work-group");
        }
      }
    },
  );

  it.each(["same-run", "independent-run", "unscoped"])(
    "keeps %s trailing activity with its presentation owner",
    (ownership) => {
      const messages = [
        { role: "user", content: "Watch the queue", timestamp: 1 },
        {
          role: "assistant",
          phase: "commentary",
          content: "Checking",
          timestamp: 2,
          runId: "reply",
        },
        {
          role: "assistant",
          phase: "final_answer",
          content: "Watching",
          timestamp: 3,
          runId: "reply",
        },
        ...[1, 2].flatMap((index) => {
          const runId =
            ownership === "unscoped"
              ? undefined
              : ownership === "same-run"
                ? "reply"
                : `wake-${index}`;
          return [
            {
              role: "assistant",
              content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: {} }],
              timestamp: 4 * index,
              runId,
            },
            {
              role: "toolResult",
              toolCallId: `call-${index}`,
              toolName: "read",
              content: "ok",
              timestamp: 4 * index + 1,
              runId,
            },
          ];
        }),
      ];
      for (const history of [messages, structuredClone(messages)]) {
        const items = coalesceActivityRuns(
          collapseCompletedTurnWork(
            groupMessages(
              history.map((message, index) => ({
                kind: "message",
                key: `message:${index}`,
                message,
              })),
            ),
            {
              sessionKey: "agent:main:dashboard:answers",
              runWorking: false,
            },
          ),
        );
        expect(items.map((item) => item.kind)).toEqual(
          ownership === "independent-run"
            ? ["group", "work-group", "group", "activity-run"]
            : ["group", "work-group", "group"],
        );
        const work = items.filter((item) => item.kind === "work-group");
        expect(
          work.flatMap((item) =>
            item.groups.flatMap((group) => group.messages.map(({ message }) => message)),
          ),
        ).toEqual(
          ownership === "independent-run" ? [messages[1]] : [messages[1], ...messages.slice(3)],
        );
        if (ownership === "independent-run") {
          expect(work[0]?.durationMs).toBeNull();
        }
        const activity = items.filter((item) => item.kind === "activity-run");
        expect(
          activity.flatMap((item) =>
            item.groups.flatMap((group) => group.messages.map(({ message }) => message)),
          ),
        ).toEqual(ownership === "independent-run" ? messages.slice(3) : []);
      }
    },
  );

  it("collects activity on both sides of answers without crossing the next user", () => {
    const messages = [
      { role: "user", content: "First question", timestamp: 1 },
      { role: "assistant", phase: "commentary", content: "Checking first", timestamp: 2 },
      { role: "assistant", phase: "final_answer", content: "First answer", timestamp: 3 },
      {
        role: "toolResult",
        toolCallId: "first",
        toolName: "read",
        content: "Evidence",
        timestamp: 4,
      },
      { role: "assistant", phase: "final_answer", content: "Addendum", timestamp: 5 },
      { role: "assistant", phase: "commentary", content: "Final check", timestamp: 6 },
      {
        role: "toolResult",
        toolCallId: "last",
        toolName: "read",
        content: "Confirmed",
        timestamp: 7,
      },
      { role: "user", content: "Second question", timestamp: 8 },
      { role: "assistant", phase: "commentary", content: "Checking second", timestamp: 9 },
      { role: "assistant", phase: "final_answer", content: "Second answer", timestamp: 10 },
    ];
    const snapshot = structuredClone(messages);
    const items = collapseCompletedTurnWork(cachedGroups(messages), {
      sessionKey: "agent:main:dashboard:answers",
      runWorking: false,
    });
    expect(items.map((item) => item.kind)).toEqual([
      "group",
      "work-group",
      "group",
      "group",
      "group",
      "work-group",
      "group",
    ]);
    const work = items.filter((item) => item.kind === "work-group");
    expect(
      work.map((item) =>
        item.groups.flatMap((group) => group.messages.map(({ message }) => message)),
      ),
    ).toEqual([[messages[1], messages[3], messages[5], messages[6]], [messages[8]]]);
    expect(work[0]?.durationMs).toBeNull();
    expect(
      items
        .filter((item) => item.kind === "group")
        .flatMap((item) => item.messages.map(({ message }) => message)),
    ).toEqual([messages[0], messages[2], messages[4], messages[7], messages[9]]);
    expect(messages).toEqual(snapshot);
  });

  it("preserves mixed-phase answer text when later tools and an answer arrive", () => {
    const answer = {
      role: "assistant",
      content: ["commentary", "final_answer"].map((phase) => ({
        type: "text",
        text: phase === "commentary" ? "Checking" : "Substantive answer",
        textSignature: JSON.stringify({ v: 1, id: phase, phase }),
      })),
      timestamp: 2,
    };
    const items = collapseCompletedTurnWork(
      cachedGroups([
        { role: "user", content: "Investigate", timestamp: 1 },
        answer,
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "read",
          content: "Evidence",
          timestamp: 3,
        },
        { role: "assistant", phase: "final_answer", content: "Later update", timestamp: 4 },
      ]),
      { sessionKey: "agent:main:dashboard:answers", runWorking: false },
    );
    expect(
      items
        .filter((item) => item.kind === "group")
        .flatMap((item) => item.messages.map(({ message }) => message)),
    ).toContainEqual(answer);
  });
});
