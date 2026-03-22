import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { defaultRuntime } from "../../../runtime.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "../queue.js";
import type { FollowupRun, QueueSettings } from "../queue.js";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createRun(params: {
  prompt: string;
  originatingChannel?: FollowupRun["originatingChannel"];
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string | number;
}): FollowupRun {
  return {
    prompt: params.prompt,
    enqueuedAt: Date.now(),
    originatingChannel: params.originatingChannel,
    originatingTo: params.originatingTo,
    originatingAccountId: params.originatingAccountId,
    originatingThreadId: params.originatingThreadId,
    run: {
      agentId: "agent",
      agentDir: "/tmp",
      sessionId: "sess",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp",
      config: {} as OpenClawConfig,
      provider: "openai",
      model: "gpt-test",
      timeoutMs: 10_000,
      blockReplyBreak: "text_end",
    },
  };
}

let previousRuntimeError: typeof defaultRuntime.error;

beforeAll(() => {
  previousRuntimeError = defaultRuntime.error;
  defaultRuntime.error = (() => {}) as typeof defaultRuntime.error;
});

afterAll(() => {
  defaultRuntime.error = previousRuntimeError;
});

describe("multi-channel Slack reply routing (regression #45514)", () => {
  it("routes items from two different Slack channels individually with correct originating metadata", async () => {
    // Regression: when two Slack channels share a queue, cross-channel detection
    // must route each item back to its own channel — not the other channel.
    const key = `test-slack-multichannel-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 2;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "msg-channel-A",
        originatingChannel: "slack",
        originatingTo: "channel:C_CHANNEL_A",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "msg-channel-B",
        originatingChannel: "slack",
        originatingTo: "channel:C_CHANNEL_B",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    // Both items must be delivered individually (cross-channel, not collected)
    expect(calls).toHaveLength(2);
    // First item must carry channel A's routing — not channel B's
    expect(calls[0]?.originatingChannel).toBe("slack");
    expect(calls[0]?.originatingTo).toBe("channel:C_CHANNEL_A");
    // Second item must carry channel B's routing — not channel A's
    expect(calls[1]?.originatingChannel).toBe("slack");
    expect(calls[1]?.originatingTo).toBe("channel:C_CHANNEL_B");
  });

  it("collect batch routing comes from a single consistent source item, not mixed across items", async () => {
    // Regression: resolveOriginRoutingMetadata must pick all routing fields from
    // the same item. Picking each field independently allows channel from one item
    // to combine with accountId/threadId from another, routing the reply wrongly.
    const key = `test-collect-single-source-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "msg-1",
        originatingChannel: "slack",
        originatingTo: "channel:C_CHANNEL_A",
        originatingAccountId: "WS_ALPHA",
        originatingThreadId: "1706000000.000001",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "msg-2",
        originatingChannel: "slack",
        originatingTo: "channel:C_CHANNEL_A",
        originatingAccountId: "WS_ALPHA",
        originatingThreadId: "1706000000.000001",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    // Same channel + same thread: must be collected into one batch call
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
    // All routing fields must be consistent — from the same source item
    expect(calls[0]?.originatingChannel).toBe("slack");
    expect(calls[0]?.originatingTo).toBe("channel:C_CHANNEL_A");
    expect(calls[0]?.originatingAccountId).toBe("WS_ALPHA");
    expect(calls[0]?.originatingThreadId).toBe("1706000000.000001");
  });

  it("does not mix routing fields when first item has channel and later item has accountId", async () => {
    // Regression: with independent .find() calls, originatingChannel could come
    // from item[0] and originatingAccountId from item[1], producing a mixed
    // routing context. Items from different channels are detected as cross-channel
    // and processed individually — each with its own complete routing.
    const key = `test-no-field-mixing-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 2;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    // Item from channel A with accountId WS_A
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "from-A",
        originatingChannel: "slack",
        originatingTo: "channel:C_A",
        originatingAccountId: "WS_A",
      }),
      settings,
    );
    // Item from channel B with accountId WS_B
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "from-B",
        originatingChannel: "slack",
        originatingTo: "channel:C_B",
        originatingAccountId: "WS_B",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    // Items from different channels/accounts must be processed individually
    expect(calls).toHaveLength(2);
    // Each call must carry its own complete, unmixed routing
    expect(calls[0]?.originatingChannel).toBe("slack");
    expect(calls[0]?.originatingTo).toBe("channel:C_A");
    expect(calls[0]?.originatingAccountId).toBe("WS_A");
    expect(calls[1]?.originatingChannel).toBe("slack");
    expect(calls[1]?.originatingTo).toBe("channel:C_B");
    expect(calls[1]?.originatingAccountId).toBe("WS_B");
  });
});
