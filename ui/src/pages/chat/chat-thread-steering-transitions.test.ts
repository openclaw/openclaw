import { afterEach, describe, expect, it, vi } from "vitest";
import { createProps } from "./chat-thread.test-support.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";
import { projectTranscriptChain } from "./components/chat-transcript-message-index.ts";
import { resetToolStream } from "./tool-stream-state.ts";
import {
  agentEvent,
  createHost,
  TOOL_STREAM_TEST_NOW,
  useToolStreamFakeTimers,
} from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

const runId = "active-run";
const sessionKey = "agent:main:dashboard:steering-probe";
const hosts: ReturnType<typeof createHost>[] = [];
const message = (
  role: string,
  content: unknown,
  seq: number,
  metadata: Record<string, unknown> = {},
) => ({
  role,
  content,
  timestamp: TOOL_STREAM_TEST_NOW + seq * 100,
  __openclaw: {
    id: "entry-" + seq,
    seq,
    ...(role === "user" ? { idempotencyKey: runId + ":user" } : { runId }),
    ...metadata,
  },
});
const original = () => message("user", "Inspect the workspace.", 1);
const before = () => message("assistant", "I will inspect the original request.", 2);
const steer = (seq = 3) =>
  message("user", "Focus on the second example.", seq, {
    idempotencyKey: "steer-" + seq + ":user",
    steerTargetRunId: runId,
  });
function host(messages: unknown[]) {
  useToolStreamFakeTimers();
  const value = createHost({ sessionKey, chatRunId: runId, chatMessages: messages });
  hosts.push(value);
  return value;
}
function emit(
  value: ReturnType<typeof host>,
  seq: number,
  stream: "tool" | "item",
  data: Record<string, unknown>,
) {
  vi.setSystemTime(TOOL_STREAM_TEST_NOW + seq * 100);
  handleAgentEvent(value, agentEvent(runId, seq, stream, data, sessionKey));
  vi.advanceTimersByTime(100);
}
function preamble(value: ReturnType<typeof host>, seq: number) {
  emit(value, seq, "item", {
    kind: "preamble",
    itemId: "preamble-" + seq,
    phase: "end",
    progressText: "I will focus on the second example.",
  });
}
function tool(value: ReturnType<typeof host>, seq: number) {
  emit(value, seq, "tool", {
    phase: "start",
    name: "read",
    toolCallId: "read-" + seq,
    args: { path: "example.ts" },
  });
}
function snapshot(value: ReturnType<typeof host>, working = true) {
  const messages = value.chatMessages ?? [];
  const items = buildCachedChatItems(
    createProps({
      paneId: sessionKey,
      sessionKey,
      messages,
      toolMessages: value.chatToolMessages,
      streamSegments: value.chatStreamSegments,
      stream: null,
      streamStartedAt: TOOL_STREAM_TEST_NOW + 100,
      runId: working ? runId : null,
      runWorking: working,
      runActive: working,
    }),
  );
  return projectTranscriptChain(items, {
    sessionKey,
    runWorking: working,
    searchActive: false,
    activeRunId: working ? runId : null,
    messages,
  }).transcriptItems;
}
function shape(value: ReturnType<typeof host>, working = true) {
  return snapshot(value, working).map((item) =>
    item.kind === "group" && item.role === "user" ? "user" : item.kind,
  );
}
afterEach(() => {
  hosts.splice(0).forEach((value) => resetToolStream(value));
  resetChatThreadState();
  vi.useRealTimers();
});
describe("steering keeps the before and after responses in place", () => {
  it("keeps ordinary tools and live commentary in one response", () => {
    const value = host([original()]);
    tool(value, 4);
    preamble(value, 5);
    expect(shape(value)).toEqual(["user", "agent-run-frame"]);
  });
  it("splits streaming text once, at the steering message", () => {
    const value = host([original(), before(), steer()]);
    preamble(value, 5);
    expect(shape(value)).toEqual(["user", "agent-run-frame", "user", "agent-run-frame"]);
  });
  it("does not add a third response when a tool starts after steering", () => {
    const value = host([original(), before(), steer()]);
    tool(value, 4);
    preamble(value, 5);
    expect(shape(value)).toEqual(["user", "agent-run-frame", "user", "agent-run-frame"]);
  });
  it("keeps a pre-steer tool and its delayed result above the steering message", () => {
    const value = host([original(), before()]);
    tool(value, 3);
    value.chatMessages = [...value.chatMessages!, steer(4)];
    emit(value, 5, "tool", { phase: "result", name: "read", toolCallId: "read-3", result: "Done" });
    preamble(value, 6);
    expect(shape(value)).toEqual(["user", "agent-run-frame", "user", "agent-run-frame"]);
    const rows = snapshot(value);
    const first = rows[1];
    expect(first?.kind).toBe("agent-run-frame");
    if (first?.kind !== "agent-run-frame") {
      throw new Error("missing first response");
    }
    expect(first.parts.some((part) => part.kind === "group" && part.role === "tool")).toBe(true);
  });
  it("keeps saved post-steer text and tools with the remaining working indicator", () => {
    const value = host([
      original(),
      before(),
      steer(),
      message("assistant", "I will focus on the second example.", 4),
      message(
        "assistant",
        [{ type: "toolCall", id: "saved-read", name: "read", arguments: { path: "example.ts" } }],
        5,
      ),
    ]);
    expect(shape(value)).toEqual(["user", "agent-run-frame", "user", "agent-run-frame"]);
  });
  it("keeps completed history split only at the steering message", () => {
    const value = host([
      original(),
      before(),
      steer(),
      message("assistant", "The second example is checked.", 6),
    ]);
    expect(shape(value, false)).toEqual(["user", "agent-run-frame", "user", "agent-run-frame"]);
  });
  it("keeps separate reply blocks for repeated steers in the same execution", () => {
    const value = host([original(), before(), steer()]);
    preamble(value, 4);
    value.chatMessages = [
      ...value.chatMessages!,
      message("assistant", "First correction handled.", 5),
      steer(6),
    ];
    tool(value, 7);
    preamble(value, 8);
    expect(shape(value)).toEqual([
      "user",
      "agent-run-frame",
      "user",
      "agent-run-frame",
      "user",
      "agent-run-frame",
    ]);
    const frames = snapshot(value).filter((item) => item.kind === "agent-run-frame");
    expect(new Set(frames.map((frame) => frame.key)).size).toBe(3);
  });
  it("preserves the post-steer reply key from waiting through tools and saved history", () => {
    const value = host([original(), before(), steer()]);
    const key = snapshot(value).findLast((item) => item.kind === "agent-run-frame")?.key;
    tool(value, 4);
    preamble(value, 5);
    expect(snapshot(value).findLast((item) => item.kind === "agent-run-frame")?.key).toBe(key);
    value.chatMessages = [
      ...value.chatMessages!,
      message("assistant", "The startup script names a missing file.", 6),
    ];
    value.chatToolMessages = [];
    value.chatStreamSegments = [];
    expect(snapshot(value, false).findLast((item) => item.kind === "agent-run-frame")?.key).toBe(
      key,
    );
  });
  it("preserves a post-steer reply when earlier history is loaded", () => {
    const value = host([steer()]);
    tool(value, 4);
    preamble(value, 5);
    const key = snapshot(value).findLast((item) => item.kind === "agent-run-frame")?.key;
    value.chatMessages = [original(), before(), ...value.chatMessages!];
    expect(snapshot(value).findLast((item) => item.kind === "agent-run-frame")?.key).toBe(key);
  });
  it("does not move or replace the existing response when steering is inserted", () => {
    const value = host([original(), before()]);
    const prior = snapshot(value).find((item) => item.kind === "agent-run-frame");
    value.chatMessages = [...value.chatMessages!, steer()];
    tool(value, 4);
    preamble(value, 5);
    const rows = snapshot(value);
    expect(rows[1]?.key).toBe(prior?.key);
    expect(rows[2]?.kind).toBe("group");
    const earlier = rows[1];
    if (earlier?.kind !== "agent-run-frame") {
      throw new Error("missing original response");
    }
    expect(
      earlier.parts.flatMap((part) =>
        part.kind === "group" ? part.messages.map((source) => source.message) : [],
      ),
    ).toContain(value.chatMessages![1]);
  });
});
