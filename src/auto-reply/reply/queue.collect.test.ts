import { describe, expect, it } from "vitest";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import {
  createDeferred,
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";

installQueueRuntimeErrorSilencer();

describe("followup queue collect routing", () => {
  it("does not collect when destinations differ", async () => {
    const key = `test-collect-diff-to-${Date.now()}`;
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
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("transient failure");
      }
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(key, createRun({ prompt: "one" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "two" }), settings);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.prompt).toContain("Queued #1\none");
    expect(calls[0]?.prompt).toContain("Queued #2\ntwo");
  });

  it("retries overflow summary delivery without losing dropped previews", async () => {
    const key = `test-overflow-summary-retry-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("transient failure");
      }
      calls.push(run);
      done.resolve();
    };
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

  it("preserves routing metadata on overflow summary followups", async () => {
    const key = `test-overflow-summary-routing-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "first",
        originatingChannel: "discord",
        originatingTo: "channel:C1",
        originatingAccountId: "work",
        originatingThreadId: "1739142736.000100",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "second",
        originatingChannel: "discord",
        originatingTo: "channel:C1",
        originatingAccountId: "work",
        originatingThreadId: "1739142736.000100",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls[0]?.originatingChannel).toBe("discord");
    expect(calls[0]?.originatingTo).toBe("channel:C1");
    expect(calls[0]?.originatingAccountId).toBe("work");
    expect(calls[0]?.originatingThreadId).toBe("1739142736.000100");
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
  });
});
