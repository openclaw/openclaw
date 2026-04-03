import { afterEach, describe, expect, it } from "vitest";
import { enqueueFollowupRun, enqueueFollowupRunDetailed } from "./enqueue.js";
import { clearFollowupQueue } from "./state.js";
import type { FollowupRun, QueueSettings } from "./types.js";

const KEY = "session:test";

function createRun(overrides?: Partial<FollowupRun>): FollowupRun {
  return {
    prompt: overrides?.prompt ?? "hello",
    messageId: overrides?.messageId ?? "msg-1",
    summaryLine: overrides?.summaryLine ?? "hello",
    enqueuedAt: overrides?.enqueuedAt ?? Date.now(),
    originatingChannel: overrides?.originatingChannel ?? "feishu",
    originatingTo: overrides?.originatingTo ?? "chat:1",
    originatingAccountId: overrides?.originatingAccountId ?? "default",
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session-1",
      sessionKey: KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      provider: "anthropic",
      model: "claude",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      ...overrides?.run,
    },
  } as FollowupRun;
}

const settings: QueueSettings = {
  mode: "followup",
  debounceMs: 0,
  cap: 10,
  dropPolicy: "summarize",
};

afterEach(() => {
  clearFollowupQueue(KEY);
});

describe("enqueueFollowupRunDetailed", () => {
  it("returns queue depth for accepted items", () => {
    const result = enqueueFollowupRunDetailed(KEY, createRun(), settings);

    expect(result).toEqual({
      accepted: true,
      reason: "enqueued",
      queueDepth: 1,
    });
  });

  it("reports duplicates without adding another queued item", () => {
    enqueueFollowupRunDetailed(KEY, createRun({ messageId: "same-id" }), settings);

    const result = enqueueFollowupRunDetailed(KEY, createRun({ messageId: "same-id" }), settings);

    expect(result).toEqual({
      accepted: false,
      reason: "duplicate",
      queueDepth: 1,
    });
  });

  it("reports queue_full when drop:new rejects a backlog overflow", () => {
    const fullQueueSettings: QueueSettings = {
      ...settings,
      cap: 1,
      dropPolicy: "new",
    };
    expect(enqueueFollowupRun(KEY, createRun({ messageId: "first" }), fullQueueSettings)).toBe(
      true,
    );

    const result = enqueueFollowupRunDetailed(
      KEY,
      createRun({ messageId: "second" }),
      fullQueueSettings,
    );

    expect(result).toEqual({
      accepted: false,
      reason: "queue_full",
      queueDepth: 1,
    });
  });
});
