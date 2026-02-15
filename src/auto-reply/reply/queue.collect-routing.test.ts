import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { defaultRuntime } from "../../runtime.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let previousRuntimeError: typeof defaultRuntime.error;

beforeAll(() => {
  previousRuntimeError = defaultRuntime.error;
  defaultRuntime.error = undefined;
});

afterAll(() => {
  defaultRuntime.error = previousRuntimeError;
});

const COLLECT_SETTINGS: QueueSettings = {
  mode: "collect",
  debounceMs: 0,
  cap: 50,
  dropPolicy: "summarize",
};

function createRun(params: {
  prompt: string;
  messageId?: string;
  originatingChannel?: FollowupRun["originatingChannel"];
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string | number;
}): FollowupRun {
  return {
    prompt: params.prompt,
    messageId: params.messageId,
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

function createHarness(params: {
  expectedCalls: number;
  runFollowup?: (
    run: FollowupRun,
    ctx: {
      calls: FollowupRun[];
      done: ReturnType<typeof createDeferred<void>>;
      expectedCalls: number;
    },
  ) => Promise<void>;
}) {
  const calls: FollowupRun[] = [];
  const done = createDeferred<void>();
  const expectedCalls = params.expectedCalls;
  const runFollowup = async (run: FollowupRun) => {
    if (params.runFollowup) {
      await params.runFollowup(run, { calls, done, expectedCalls });
      return;
    }
    calls.push(run);
    if (calls.length >= expectedCalls) {
      done.resolve();
    }
  };
  return { calls, done, runFollowup, expectedCalls };
}

describe("followup queue deduplication", () => {
  it("deduplicates messages with same Discord message_id", async () => {
    const key = `test-dedup-message-id-${Date.now()}`;
    const { calls, done, runFollowup } = createHarness({ expectedCalls: 1 });

    // First enqueue should succeed
    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "[Discord Guild #test channel id:123] Hello",
        messageId: "m1",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      COLLECT_SETTINGS,
    );
    expect(first).toBe(true);

    // Second enqueue with same message id should be deduplicated
    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "[Discord Guild #test channel id:123] Hello (dupe)",
        messageId: "m1",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      COLLECT_SETTINGS,
    );
    expect(second).toBe(false);

    // Third enqueue with different message id should succeed
    const third = enqueueFollowupRun(
      key,
      createRun({
        prompt: "[Discord Guild #test channel id:123] World",
        messageId: "m2",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      COLLECT_SETTINGS,
    );
    expect(third).toBe(true);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    // Should collect both unique messages
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
  });

  it("deduplicates exact prompt when routing matches and no message id", async () => {
    const key = `test-dedup-whatsapp-${Date.now()}`;
    const settings = COLLECT_SETTINGS;

    // First enqueue should succeed
    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Hello world",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      settings,
    );
    expect(first).toBe(true);

    // Second enqueue with same prompt should be allowed (default dedupe: message id only)
    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Hello world",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      settings,
    );
    expect(second).toBe(true);

    // Third enqueue with different prompt should succeed
    const third = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Hello world 2",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      settings,
    );
    expect(third).toBe(true);
  });

  it("does not deduplicate across different providers without message id", async () => {
    const key = `test-dedup-cross-provider-${Date.now()}`;
    const settings = COLLECT_SETTINGS;

    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Same text",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      settings,
    );
    expect(first).toBe(true);

    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Same text",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      settings,
    );
    expect(second).toBe(true);
  });

  it("can opt-in to prompt-based dedupe when message id is absent", async () => {
    const key = `test-dedup-prompt-mode-${Date.now()}`;
    const settings = COLLECT_SETTINGS;

    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Hello world",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      settings,
      "prompt",
    );
    expect(first).toBe(true);

    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Hello world",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      settings,
      "prompt",
    );
    expect(second).toBe(false);
  });
});

describe("followup queue collect routing", () => {
  it("does not collect when destinations differ", async () => {
    const key = `test-collect-diff-to-${Date.now()}`;
    const { calls, done, runFollowup } = createHarness({ expectedCalls: 2 });
    const settings = COLLECT_SETTINGS;

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:B",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.prompt).toBe("one");
    expect(calls[1]?.prompt).toBe("two");
  });

  it("collects when channel+destination match", async () => {
    const key = `test-collect-same-to-${Date.now()}`;
    const { calls, done, runFollowup } = createHarness({ expectedCalls: 1 });
    const settings = COLLECT_SETTINGS;

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
    expect(calls[0]?.originatingChannel).toBe("slack");
    expect(calls[0]?.originatingTo).toBe("channel:A");
  });

  it("collects Slack messages in same thread and preserves string thread id", async () => {
    const key = `test-collect-slack-thread-same-${Date.now()}`;
    const { calls, done, runFollowup } = createHarness({ expectedCalls: 1 });
    const settings = COLLECT_SETTINGS;

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000001",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000001",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
    expect(calls[0]?.originatingThreadId).toBe("1706000000.000001");
  });

  it("does not collect Slack messages when thread ids differ", async () => {
    const key = `test-collect-slack-thread-diff-${Date.now()}`;
    const { calls, done, runFollowup } = createHarness({ expectedCalls: 2 });
    const settings = COLLECT_SETTINGS;

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000001",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000002",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.prompt).toBe("one");
    expect(calls[1]?.prompt).toBe("two");
    expect(calls[0]?.originatingThreadId).toBe("1706000000.000001");
    expect(calls[1]?.originatingThreadId).toBe("1706000000.000002");
  });

  it("retries collect-mode batches without losing queued items", async () => {
    const key = `test-collect-retry-${Date.now()}`;
    let attempt = 0;
    const { calls, done, runFollowup } = createHarness({
      expectedCalls: 1,
      runFollowup: async (run, ctx) => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("transient failure");
        }
        ctx.calls.push(run);
        if (ctx.calls.length >= ctx.expectedCalls) {
          ctx.done.resolve();
        }
      },
    });
    const settings = COLLECT_SETTINGS;

    enqueueFollowupRun(key, createRun({ prompt: "one" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "two" }), settings);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.prompt).toContain("Queued #1\none");
    expect(calls[0]?.prompt).toContain("Queued #2\ntwo");
  });

  it("retries overflow summary delivery without losing dropped previews", async () => {
    const key = `test-overflow-summary-retry-${Date.now()}`;
    let attempt = 0;
    const { calls, done, runFollowup } = createHarness({
      expectedCalls: 1,
      runFollowup: async (run, ctx) => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("transient failure");
        }
        ctx.calls.push(run);
        if (ctx.calls.length >= ctx.expectedCalls) {
          ctx.done.resolve();
        }
      },
    });
    const settings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(key, createRun({ prompt: "first" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "second" }), settings);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(calls[0]?.prompt).toContain("- first");
  });
});
