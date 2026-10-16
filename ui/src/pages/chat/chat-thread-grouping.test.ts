// @vitest-environment node
import { beforeEach, expect, it } from "vitest";
import type { MessageClientSource } from "../../../../src/chat/message-client-source.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";
import {
  assistantGroupCanOwnActiveRunStatus,
  collapseCompletedTurnWork,
  coalesceActivityRuns,
  groupMessages,
} from "./chat-thread-grouping.ts";
import { buildItems, type CachedChatItemsProps } from "./chat-thread.test-support.ts";
import { resetChatThreadState } from "./chat-thread.ts";

const sessionKey = "agent:main:dashboard:answers";
const cli: MessageClientSource = { id: "cli", mode: "cli", displayName: "Release helper" };
const web: MessageClientSource = { id: "openclaw-control-ui", mode: "webchat" };
function message(role: string, content: unknown, timestamp: number, extra: object = {}) {
  return { role, content, timestamp, ...extra };
}
function cachedGroups(messages: unknown[]) {
  return buildItems({ messages }).filter((item) => item.kind === "group");
}
function groupHistory(messages: unknown[], showReasoning = false) {
  return groupMessages(
    messages.map((entry, index) => ({ kind: "message", key: `message:${index}`, message: entry })),
    {},
    undefined,
    showReasoning,
  );
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
function work(
  items: ReturnType<typeof projected>,
  kind: "work-group" | "activity-run" = "work-group",
) {
  return items
    .filter((item) => item.kind === "work-group" || item.kind === "activity-run")
    .filter((item) => item.kind === kind)
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
function expectProvenance(messages: unknown[]) {
  const groups = cachedGroups(messages);
  expect(groups.map((group) => group.messages.map((source) => source.message))).toEqual([messages]);
  expect(groups.flatMap((group) => group.messages).map((entry) => entry.duplicateCount)).toEqual([
    undefined,
    undefined,
  ]);
  return groups;
}
function expectHistory(messages: unknown[], shown: unknown[], folded: unknown[]) {
  for (const history of [messages, structuredClone(messages)]) {
    const items = projected(history);
    expect({ shown: visible(items), folded: work(items) }).toEqual({ shown, folded });
    expect(items.filter((item) => item.kind === "work-group")).toHaveLength(folded.length ? 1 : 0);
    if (folded.length) {
      expect(items[1]?.kind).toBe("work-group");
    }
  }
}
beforeEach(() => resetChatThreadState());

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
    message: message("user", item.text, index + 1, {
      __openclaw: { id: `pending:accepted-${index}` },
    }),
  }));
  const persisted = queue.map((item, index) =>
    message("user", item.text, index + 1, {
      __openclaw: {
        id: `persisted-${index}`,
        seq: index + 1,
        idempotencyKey: `${item.sendRunId}:user`,
        runId: `execution-${index}`,
      },
    }),
  );
  const render = (input: Pick<CachedChatItemsProps, "messages" | "pendingInputs">) =>
    buildItems({
      paneId: "queued-input-continuity",
      sessionKey: "agent:main:dashboard:queued-inputs",
      queue,
      ...input,
    }).filter((item) => item.kind === "group");
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
it("groups messages from the same collected sources without losing provenance", () => {
  const clients = [cli, web];
  const from = (content: string) =>
    message("user", content, 1, {
      __openclaw: {
        senderId: "same-person",
        senderIdentity: { type: "profile", id: "same-person" },
        transport: { clients },
      },
    });
  const groups = expectProvenance([from("Continue"), from("Next turn")]);
  expect(groups.map((group) => group.sourceClients)).toEqual([clients]);
  expect(groups.map((group) => group.sender?.identity)).toEqual([
    { type: "profile", id: "same-person" },
  ]);
});

it("preserves forwarded provenance for the same source", () => {
  const origin = { sessionKey: "agent:main:main", agentId: "main", label: undefined };
  const messages = ["Report", "Second report"].map((text) =>
    message("assistant", text, 1, {
      senderLabel: "Forwarded from main",
      senderSession: { ...origin },
    }),
  );
  const groups = expectProvenance(messages);
  expect(groups.map((group) => group.senderSession)).toEqual([origin]);
  expect(groups.map((group) => group.senderLabel)).toEqual(["Forwarded from main"]);
});
it.each([
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
])("keeps mixed reasoning and $type visible", (outcome) => {
  const thinking = { type: "thinking", thinking: "Checking the evidence." };
  const messages = [
    message("user", "Check it.", 1000),
    message("assistant", [thinking], 2000),
    message("assistant", [thinking, outcome], 3000),
  ];
  const groups = groupHistory(messages, true);
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

it("preserves malformed user content", () => {
  for (const content of [[null], [null, { type: "text", text: "Still visible" }]]) {
    const entry = { role: "user", content };
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
it.each([true, false])(
  "keeps work with its answer above a trailing steer (working=%s)",
  (runWorking) => {
    const runId = "target-run";
    const prompt = message("user", "Inspect the file", 1, {
      __openclaw: { idempotencyKey: `${runId}:user` },
    });
    const evidence = tool("read-file", 2, { runId });
    const answer = message("assistant", "File inspected", 3, { runId });
    const queued = message("user", "Queued follow-up", 4, {
      __openclaw: { idempotencyKey: "queued-run:user" },
    });
    const steer = message("user", "Also check permissions", 5, {
      __openclaw: {
        idempotencyKey: "steer-run:user",
        steerTargetRunId: runId,
      },
    });
    const ordered = [prompt, evidence, answer, queued, steer];
    const items = collapseCompletedTurnWork(groupHistory(ordered), {
      sessionKey,
      runWorking,
      session: { key: sessionKey, lastRunId: runId, status: "done", runtimeMs: 321 },
    });
    expect(visible(items)).toEqual(runWorking ? ordered : [prompt, answer, queued, steer]);
    expect(work(items)).toEqual(runWorking ? [] : [evidence]);
    if (!runWorking) {
      expect(items[1]).toMatchObject({ kind: "work-group", replyRunId: runId, durationMs: 321 });
    }
  },
);

it.each<[string, object, boolean, boolean?]>([
  ["settled terminal", {}, true],
  ["explicit commentary", { phase: "commentary" }, false],
  ["interrupted text", { openclawAbort: { aborted: true } }, false],
  ["legacy unphased reply", {}, false, true],
])("preserves %s through history reload", (_name, extra, preserved, legacy) => {
  const run = { runId: "completed-run" };
  const messages = [
    message("user", "Inspect the file", 1, { __openclaw: run }),
    tool("read-file", 2, { __openclaw: run }),
    message("assistant", "File verified — café 雪 🦞", 3, {
      stopReason: "stop",
      ...extra,
      __openclaw: {
        ...run,
        ...(!legacy ? { mirrorOrigin: "codex-app-server", runTerminal: true } : {}),
      },
    }),
    message("assistant", "Gateway restart config-patch ok", 4, {
      api: "openclaw-transcript",
      provider: "openclaw",
      model: "delivery-mirror",
      stopReason: "stop",
    }),
  ];
  expectHistory(
    messages,
    [messages[0], ...(preserved ? [messages[2]] : []), messages[3]],
    [messages[1], ...(!preserved ? [messages[2]] : [])],
  );
});
it.each([
  { phase: "final_answer", withTool: false },
  { phase: "commentary", withTool: true },
])(
  "preserves signed answer before $phase, tool=$withTool through history reload",
  ({ phase, withTool }) => {
    const run = { __openclaw: { runId: "run" } };
    const first = message("user", "Investigate", 1, run);
    const answer = message("assistant", [signed("Substantive answer", "final_answer")], 2, run);
    const evidence = withTool ? [tool("call", 3, run)] : [];
    const later = message("assistant", [signed("Later update", phase)], 4, run);
    expectHistory(
      [first, answer, ...evidence, later],
      [first, answer, ...(phase === "final_answer" ? [later] : [])],
      [...evidence, ...(phase === "commentary" ? [later] : [])],
    );
  },
);

it("keeps independent-run trailing activity with its owner", () => {
  const messages = [
    message("user", "Watch the queue", 1),
    message("assistant", "Checking", 2, { phase: "commentary", runId: "reply" }),
    message("assistant", "Watching", 3, { phase: "final_answer", runId: "reply" }),
    ...[1, 2].flatMap((index) => {
      const runId = `wake-${index}`;
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
    const items = coalesceActivityRuns(
      collapseCompletedTurnWork(groupHistory(history), { sessionKey, runWorking: false }),
    );
    expect(items.map((item) => item.kind)).toEqual([
      "group",
      "work-group",
      "group",
      "activity-run",
    ]);
    expect(work(items)).toEqual([messages[1]]);
    expect(items.find((item) => item.kind === "work-group")?.durationMs).toBeNull();
    expect(work(items, "activity-run")).toEqual(messages.slice(3));
  }
});

it("keeps thinking plus tool calls as activity and omits assistant rows with nothing to display", () => {
  const groups = cachedGroups([
    message("user", "Check the parent", 1_000),
    message(
      "assistant",
      [
        { type: "thinking", thinking: "Find the parent." },
        { type: "toolCall", id: "list", name: "sessions_list", arguments: {} },
      ],
      2_000,
    ),
    message("assistant", [{ type: "thinking", thinking: "Nothing to say." }], 3_000),
  ]);
  expect(groups.map((item) => item.role)).toEqual(["user", "tool"]);
});

it("retains prepared tool outcomes without content blocks as activity", () => {
  const outcome = message("assistant", [], 1_000, {
    activity: [
      {
        itemId: "read",
        kind: "tool",
        phase: "end",
        name: "read",
        title: "Read",
        status: "blocked",
      },
    ],
  });
  expect(buildItems({ messages: [outcome] })).toMatchObject([
    { kind: "group", role: "tool", messages: [{ message: outcome }] },
  ]);
});
