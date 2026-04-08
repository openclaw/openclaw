import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import type { OpenClawConfig } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import {
  enqueueFollowupRun,
  resetRecentQueuedMessageIdDedupe,
  scheduleFollowupDrain,
} from "./queue.js";

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

let previousRuntimeError: typeof defaultRuntime.error;

beforeAll(() => {
  previousRuntimeError = defaultRuntime.error;
  defaultRuntime.error = (() => {}) as typeof defaultRuntime.error;
});

afterAll(() => {
  defaultRuntime.error = previousRuntimeError;
});

describe("followup queue deduplication", () => {
  beforeEach(() => {
    resetRecentQueuedMessageIdDedupe();
  });

  it("deduplicates messages with same Discord message_id", async () => {
    const key = `test-dedup-message-id-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 1;
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

    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "[Discord Guild #test channel id:123] Hello",
        messageId: "m1",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      settings,
    );
    expect(first).toBe(true);

    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "[Discord Guild #test channel id:123] Hello (dupe)",
        messageId: "m1",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      settings,
    );
    expect(second).toBe(false);

    const third = enqueueFollowupRun(
      key,
      createRun({
        prompt: "[Discord Guild #test channel id:123] World",
        messageId: "m2",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      settings,
    );
    expect(third).toBe(true);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
  });

  it("deduplicates same message_id after queue drain restarts", async () => {
    const key = `test-dedup-after-drain-${Date.now()}`;
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

    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "first",
        messageId: "same-id",
        originatingChannel: "signal",
        originatingTo: "+10000000000",
      }),
      settings,
    );
    expect(first).toBe(true);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    const redelivery = enqueueFollowupRun(
      key,
      createRun({
        prompt: "first-redelivery",
        messageId: "same-id",
        originatingChannel: "signal",
        originatingTo: "+10000000000",
      }),
      settings,
    );

    expect(redelivery).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("deduplicates same message_id across distinct enqueue module instances", async () => {
    const enqueueA = await importFreshModule<typeof import("./queue/enqueue.js")>(
      import.meta.url,
      "./queue/enqueue.js?scope=dedupe-a",
    );
    const enqueueB = await importFreshModule<typeof import("./queue/enqueue.js")>(
      import.meta.url,
      "./queue/enqueue.js?scope=dedupe-b",
    );
    const { clearSessionQueues } = await import("./queue.js");
    const key = `test-dedup-cross-module-${Date.now()}`;
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

    enqueueA.resetRecentQueuedMessageIdDedupe();
    enqueueB.resetRecentQueuedMessageIdDedupe();

    try {
      expect(
        enqueueA.enqueueFollowupRun(
          key,
          createRun({
            prompt: "first",
            messageId: "same-id",
            originatingChannel: "signal",
            originatingTo: "+10000000000",
          }),
          settings,
        ),
      ).toBe(true);

      scheduleFollowupDrain(key, runFollowup);
      await done.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(
        enqueueB.enqueueFollowupRun(
          key,
          createRun({
            prompt: "first-redelivery",
            messageId: "same-id",
            originatingChannel: "signal",
            originatingTo: "+10000000000",
          }),
          settings,
        ),
      ).toBe(false);
      expect(calls).toHaveLength(1);
    } finally {
      clearSessionQueues([key]);
      enqueueA.resetRecentQueuedMessageIdDedupe();
      enqueueB.resetRecentQueuedMessageIdDedupe();
    }
  });

  it("does not collide recent message-id keys when routing contains delimiters", async () => {
    const key = `test-dedup-key-collision-${Date.now()}`;
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

    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "first",
        messageId: "same-id",
        originatingChannel: "signal|group",
        originatingTo: "peer",
      }),
      settings,
    );
    expect(first).toBe(true);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "second",
        messageId: "same-id",
        originatingChannel: "signal",
        originatingTo: "group|peer",
      }),
      settings,
    );
    expect(second).toBe(true);
  });

  it("deduplicates exact prompt when routing matches and no message id", async () => {
    const key = `test-dedup-whatsapp-${Date.now()}`;
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

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
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

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
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

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
