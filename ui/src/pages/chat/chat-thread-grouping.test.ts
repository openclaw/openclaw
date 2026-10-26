// @vitest-environment node
import { beforeEach, expect, it } from "vitest";
import type { MessageClientSource } from "../../../../src/chat/message-client-source.js";
import type { ChatQueueItem, MessageGroup } from "../../lib/chat/chat-types.ts";
import { assistantGroupCanOwnActiveRunStatus } from "./chat-assistant-reply.ts";
import {
  groupsOf,
  message,
  messagesOf,
  nativeMessage,
  pending,
  queued,
  signedText as signed,
  toolResult,
} from "./chat-thread-fixtures.test-support.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import { buildItems, type CachedChatItemsProps } from "./chat-thread.test-support.ts";
import { resetChatThreadState } from "./chat-thread.ts";
import { collapseCompletedTurnWork, coalesceActivityRuns } from "./chat-turn-presentation.ts";

const sessionKey = "agent:main:dashboard:answers";
const cli: MessageClientSource = { id: "cli", mode: "cli", displayName: "Release helper" };
const web: MessageClientSource = { id: "openclaw-control-ui", mode: "webchat" };
const clients = [cli, web];
const senderIdentity = { type: "profile", id: "same-person" };
const origin = { sessionKey: "agent:main:main", agentId: "main", label: undefined };
function cachedGroups(messages: unknown[]) {
  return groupsOf(buildItems({ messages }));
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
  return coalesceActivityRuns(collapse(messages));
}
function visible(items: ReturnType<typeof projected>) {
  return messagesOf(groupsOf(items));
}
function work(
  items: ReturnType<typeof projected>,
  kind: "work-group" | "activity-run" = "work-group",
) {
  return messagesOf(
    items.flatMap((item) =>
      (item.kind === "work-group" || item.kind === "activity-run") && item.kind === kind
        ? item.groups
        : [],
    ),
  );
}
function tool(id: string, timestamp: number, extra: object = {}) {
  return toolResult(id, "read", "Evidence", timestamp, extra);
}
function expectProvenance(messages: unknown[]) {
  const groups = cachedGroups(messages);
  expect(groups.map((group) => group.messages.map((source) => source.message))).toEqual([messages]);
  return groups;
}
function expectHistory(messages: unknown[], shown: number[], folded: number[]) {
  for (const history of [messages, structuredClone(messages)]) {
    const items = projected(history);
    expect({ shown: visible(items), folded: work(items) }).toEqual({
      shown: shown.map((index) => messages[index]),
      folded: folded.map((index) => messages[index]),
    });
    expect(items.filter((item) => item.kind === "work-group")).toHaveLength(folded.length ? 1 : 0);
    if (folded.length) {
      expect(items[1]?.kind).toBe("work-group");
    }
  }
}
beforeEach(() => resetChatThreadState());

it("keeps provider speech separate from answer ownership and completed-work rollups", () => {
  const answer = message("assistant", "The command exited with code 0.", 2);
  const speech = message("assistant", "The command exited with code zero.", 3, {
    __openclaw: { voiceTranscript: "provider-owned" },
  });
  const groups = cachedGroups([message("user", "Check the command.", 1), answer, speech]);
  expect(groups.map((group) => group.messages.map((item) => item.message))).toEqual([
    [expect.objectContaining({ role: "user" })],
    [answer],
    [speech],
  ]);
  expect(assistantGroupCanOwnActiveRunStatus(groups[1]!)).toBe(true);
  expect(assistantGroupCanOwnActiveRunStatus(groups[2]!)).toBe(false);
  expect(collapseCompletedTurnWork(groups, { sessionKey, runWorking: false })).toEqual(groups);
});

it("keeps each queued message in the same row through acceptance and persistence", () => {
  const queue: ChatQueueItem[] = ["First queued input", "Second queued input"].map((text, index) =>
    queued(`local-${index}`, text, index + 1, "waiting-reconnect", {
      sendRunId: `send-${index}`,
      sendAttempts: 1,
    }),
  );
  const pendingInputs = queue.map((item, index) =>
    pending(
      `accepted-${index}`,
      item.sendRunId,
      nativeMessage("user", item.text, index + 1, { id: `pending:accepted-${index}` }),
      index + 1,
    ),
  );
  const persisted = queue.map((item, index) =>
    nativeMessage("user", item.text, index + 1, {
      id: `persisted-${index}`,
      seq: index + 1,
      idempotencyKey: `${item.sendRunId}:user`,
      runId: `execution-${index}`,
    }),
  );
  const render = (input: Pick<CachedChatItemsProps, "messages" | "pendingInputs">) =>
    groupsOf(
      buildItems({
        paneId: "queued-input-continuity",
        sessionKey: "agent:main:dashboard:queued-inputs",
        queue,
        ...input,
      }),
    );
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
it.each([
  {
    name: "collected clients",
    from: (content: string) =>
      nativeMessage("user", content, 1, {
        senderId: "same-person",
        senderIdentity: { ...senderIdentity },
        transport: { clients },
      }),
    attribution: (group: MessageGroup) => [group.sourceClients, group.sender?.identity],
    expected: [clients, senderIdentity],
  },
  {
    name: "forwarded session",
    from: (content: string) =>
      message("assistant", content, 1, {
        senderLabel: "Forwarded from main",
        senderSession: { ...origin },
      }),
    attribution: (group: MessageGroup) => [group.senderSession, group.senderLabel],
    expected: [origin, "Forwarded from main"],
  },
])("groups the same $name without losing provenance", ({ from, attribution, expected }) => {
  const groups = expectProvenance([from("First report"), from("Second report")]);
  expect(groups.map((group) => attribution(group))).toEqual([expected]);
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
  expectHistory(messages, [0, 1, 3], [2]);
  const replacement = { ...preview, content: [{ type: "text", text: "Preparing a diagram" }] };
  expectHistory(
    messages.map((entry) => (entry === preview ? replacement : entry)),
    [0, 3],
    [1, 2],
  );
});
it.each([true, false])(
  "keeps work with its answer above a trailing steer (working=%s)",
  (runWorking) => {
    const runId = "target-run";
    const prompt = nativeMessage("user", "Inspect the file", 1, {
      idempotencyKey: `${runId}:user`,
    });
    const evidence = tool("read-file", 2, { runId });
    const answer = message("assistant", "File inspected", 3, { runId });
    const queuedMessage = nativeMessage("user", "Queued follow-up", 4, {
      idempotencyKey: "queued-run:user",
    });
    const steer = nativeMessage("user", "Also check permissions", 5, {
      idempotencyKey: "steer-run:user",
      steerTargetRunId: runId,
    });
    const ordered = [prompt, evidence, answer, queuedMessage, steer];
    const items = collapseCompletedTurnWork(groupHistory(ordered), {
      sessionKey,
      runWorking,
      session: { key: sessionKey, lastRunId: runId, status: "done", runtimeMs: 321 },
    });
    expect(visible(items)).toEqual(runWorking ? ordered : [prompt, answer, queuedMessage, steer]);
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
    nativeMessage("user", "Inspect the file", 1, run),
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
  expectHistory(messages, preserved ? [0, 2, 3] : [0, 3], preserved ? [1] : [1, 2]);
});
it.each<[string, boolean, number[], number[]]>([
  ["final_answer", false, [0, 1, 2], []],
  ["commentary", true, [0, 1], [2, 3]],
])("preserves signed answer before %s through history reload", (phase, withTool, shown, folded) => {
  const run = { __openclaw: { runId: "run" } };
  const first = message("user", "Investigate", 1, run);
  const answer = message("assistant", [signed("Substantive answer", "final_answer")], 2, run);
  const evidence = withTool ? [tool("call", 3, run)] : [];
  const later = message("assistant", [signed("Later update", phase)], 4, run);
  expectHistory([first, answer, ...evidence, later], shown, folded);
});

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
