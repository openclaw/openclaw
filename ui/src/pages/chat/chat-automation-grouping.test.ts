import { expect, it } from "vitest";
import { chatItemGroups } from "./chat-agent-run-grouping.ts";
import { coalesceAutomationActivity } from "./chat-automation-grouping.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import {
  projectTranscriptChain,
  projectTranscriptIndex,
  expandReplyTargetWork,
} from "./components/chat-transcript-message-index.ts";
const sessionKey = "agent:main:dashboard:automation";
function input(id: string, jobId = "watch", runId?: string) {
  return {
    role: "assistant",
    content: "Check CI",
    timestamp: 1000,
    provenance: {
      kind: "internal_system",
      sourceTool: "cron",
      jobId,
      runId: "session-id",
      sourceSessionKey: sessionKey,
    },
    senderSession: { sessionKey, agentId: "main", label: "Watch CI" },
    __openclaw: {
      id,
      ...(runId ? { runId } : { idempotencyKey: "client-" + id + ":user" }),
      turnBoundary: true,
    },
  };
}
function tools(id: string, runId: string) {
  return {
    role: "assistant",
    timestamp: 1001,
    stopReason: "toolUse",
    content: [
      { type: "toolCall", id: "call-" + id, name: "exec", arguments: { command: "check-ci" } },
    ],
    __openclaw: { id, runId },
  };
}
function chain(messages: unknown[], searchActive = false) {
  return projectTranscriptChain(
    buildChatItems({
      paneId: "automation-regression",
      sessionKey,
      messages,
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    }),
    { sessionKey, runWorking: false, searchActive, messages },
  );
}
it("folds four scheduled checks, retains run outcomes and reveals original reply targets", () => {
  // Real scheduled inputs may carry only an entry ID, not an execution run ID.
  const messages = [0, 1, 2, 3].flatMap((i) => [
    input("input-" + i),
    tools("tools-" + i, "run-" + i),
  ]);
  const projection = chain(messages);
  expect(projection.transcriptItems).toHaveLength(1);
  const item = projection.transcriptItems[0]!;
  expect(item.kind).toBe("automation-activity");
  if (item.kind !== "automation-activity") {
    throw new Error("Expected automation activity");
  }
  expect(item.runs.map((run) => run.frame?.outcome.kind)).toEqual([
    "interrupted",
    "interrupted",
    "interrupted",
    "interrupted",
  ]);
  expect(chatItemGroups(item).flatMap((g) => g.messages.map((entry) => entry.message))).toEqual(
    messages,
  );
  const expanded = new Map<string, boolean>();
  const index = projectTranscriptIndex(projection, expanded, {});
  expect(index.loadedReplySources.get("tools-2")?.message).toBe(messages[5]);
  expect(new Set(index.messageRowKeysById.values())).toEqual(new Set([item.key]));
  expandReplyTargetWork(projection.transcriptItems, expanded, "tools-2");
  expect(expanded.get(item.key)).toBe(true);
  const manuallyExpanded = projectTranscriptIndex(projection, new Map([[item.key, true]]), {});
  expect(manuallyExpanded.positionIndex.markers).toHaveLength(4);
  expect(projection.transcriptItems.map((i) => i.key)).toEqual(
    chain(structuredClone(messages)).transcriptItems.map((i) => i.key),
  );
  expect(chain(messages, true).transcriptItems.some((i) => i.kind === "automation-activity")).toBe(
    false,
  );
});
it.each([
  { role: "user", content: "Human question", timestamp: 1002, __openclaw: { id: "human" } },
  {
    role: "assistant",
    content: "Tests failed; your decision is needed",
    stopReason: "stop",
    timestamp: 1002,
    __openclaw: { id: "answer", runId: "run-0" },
  },
  {
    role: "assistant",
    content: "CI lookup unavailable",
    stopReason: "error",
    errorMessage: "CI lookup unavailable",
    timestamp: 1002,
    __openclaw: { id: "failed", runId: "run-0" },
  },
  {
    role: "assistant",
    content: [{ type: "image", data: "synthetic-image", mimeType: "image/png" }],
    stopReason: "stop",
    timestamp: 1002,
    __openclaw: { id: "image", runId: "run-0" },
  },
  { ...tools("cancelled", "run-0"), stopReason: "aborted" },
  input("other-job", "other"),
])("preserves meaningful conversation boundaries: $role", (boundary) => {
  const messages = [
    input("first", "watch", "run-0"),
    tools("work", "run-0"),
    boundary,
    input("last", "watch", "run-1"),
    tools("work-last", "run-1"),
  ];
  const items = chain(messages).transcriptItems;
  expect(items.filter((item) => item.kind === "automation-activity")).toHaveLength(
    2 + ("provenance" in boundary ? 1 : 0),
  );
  expect(
    items.flatMap(chatItemGroups).flatMap((group) => group.messages.map((entry) => entry.message)),
  ).toContain(boundary);
});
it("associates different client and execution IDs only through their causal boundary", () => {
  const first = input("first", "watch", "input-run");
  const execution = tools("execution", "backend-run");
  const reply = { ...input("reply"), __openclaw: { id: "reply", replyToId: "human" } };
  const items = chain([first, execution, reply]).transcriptItems;
  const activity = items.find((item) => item.kind === "automation-activity");
  expect(activity?.kind === "automation-activity" && activity.runs[0]?.frame?.runId).toBe(
    "backend-run",
  );
  expect(
    items.some((item) => item.kind === "group" && item.messages.some((m) => m.message === reply)),
  ).toBe(true);
  if (activity?.kind !== "automation-activity" || !activity.runs[0]?.frame) {
    throw new Error("Expected associated execution frame");
  }
  const otherBoundary = { ...activity.runs[0].frame, boundaryId: "send:another-input" };
  const separate = coalesceAutomationActivity([activity.runs[0].input, otherBoundary]);
  expect(separate).toHaveLength(2);
  expect(separate[1]).toBe(otherBoundary);
});

it("keeps non-text tool results exposed instead of merging later checks across them", () => {
  const media = {
    role: "toolResult",
    toolCallId: "call-work",
    toolName: "exec",
    timestamp: 1002,
    content: [{ type: "image", data: "synthetic-image", mimeType: "image/png" }],
    __openclaw: { id: "tool-media", runId: "run-0" },
  };
  const projection = chain([
    input("first", "watch", "run-0"),
    tools("work", "run-0"),
    media,
    input("last", "watch", "run-1"),
    tools("later", "run-1"),
  ]);
  expect(
    projection.transcriptItems.filter((item) => item.kind === "automation-activity"),
  ).toHaveLength(2);
  const exposed = projection.transcriptItems.filter((item) => item.kind !== "automation-activity");
  expect(exposed.flatMap(chatItemGroups).some((group) => group.visibleContent === "non-text")).toBe(
    true,
  );
});
