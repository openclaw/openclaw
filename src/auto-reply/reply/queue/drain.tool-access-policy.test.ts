import { afterEach, describe, expect, it } from "vitest";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  scheduleFollowupDrain,
  type FollowupRun,
  type QueueSettings,
} from "../queue.js";
import { createQueueTestRun } from "../queue.test-helpers.js";
import { createOverflowSummaryRetrySource } from "./drain.js";

describe("queued tool access policy snapshots", () => {
  const keysToCleanup: string[] = [];

  afterEach(() => {
    clearSessionQueues(keysToCleanup.splice(0));
  });

  it("clones an individually drained run and forces a full snapshot", async () => {
    const key = `test-tool-policy-followup-${Date.now()}-${Math.random()}`;
    keysToCleanup.push(key);
    const source = createQueueTestRun({ prompt: "queued message" });
    const calls: FollowupRun[] = [];
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
    };
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

    enqueueFollowupRun(key, source, settings, "message-id", runFollowup, false);
    scheduleFollowupDrain(key, runFollowup);

    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).not.toBe(source);
    expect(calls[0]?.run).not.toBe(source.run);
    expect(calls[0]?.run.forceToolAccessPolicySnapshot).toBe(true);
    expect(source.run.forceToolAccessPolicySnapshot).toBeUndefined();
  });

  it("clones a collected run without mutating either source", async () => {
    const key = `test-tool-policy-collect-${Date.now()}-${Math.random()}`;
    keysToCleanup.push(key);
    const first = createQueueTestRun({ prompt: "first" });
    const second = createQueueTestRun({ prompt: "second" });
    const calls: FollowupRun[] = [];
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
    };
    const settings: QueueSettings = { mode: "collect", debounceMs: 0, cap: 50 };

    enqueueFollowupRun(key, first, settings, "message-id", runFollowup, false);
    enqueueFollowupRun(key, second, settings, "message-id", runFollowup, false);
    scheduleFollowupDrain(key, runFollowup);

    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]?.run).not.toBe(second.run);
    expect(calls[0]?.run.forceToolAccessPolicySnapshot).toBe(true);
    expect(first.run.forceToolAccessPolicySnapshot).toBeUndefined();
    expect(second.run.forceToolAccessPolicySnapshot).toBeUndefined();
  });

  it("clones overflow retry run state and forces a full snapshot", () => {
    const source = createQueueTestRun({ prompt: "overflow" });

    const retry = createOverflowSummaryRetrySource(source);

    expect(retry).not.toBe(source);
    expect(retry.run).not.toBe(source.run);
    expect(retry.run.forceToolAccessPolicySnapshot).toBe(true);
    expect(source.run.forceToolAccessPolicySnapshot).toBeUndefined();
  });
});
