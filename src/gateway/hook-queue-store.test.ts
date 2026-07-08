// Hook queue store tests cover durable queue ordering.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  claimNextHookQueueItem,
  enqueueHookQueueItem,
  setHookQueuePaused,
  summarizeHookQueueItems,
  type QueuedHookAgentPayload,
} from "./hook-queue-store.js";

let envSnapshot: ReturnType<typeof captureEnv>;
let stateDir: string;

function queuedPayload(message: string): QueuedHookAgentPayload {
  return {
    name: "Import",
    message,
    agentId: "hooks",
    sessionKey: "hook:batch",
    sessionTarget: "isolated",
    wakeMode: "now",
    deliver: true,
    channel: "last",
    sourcePath: "/hooks/queue/batch",
  };
}

describe("hook queue store", () => {
  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    stateDir = mkdtempSync(join(tmpdir(), "openclaw-hook-queue-store-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("claims same-millisecond enqueues in insertion order", () => {
    const queueId = "batch";
    const createdAtMs = 1_000;

    enqueueHookQueueItem({
      itemId: "z-first",
      queueId,
      runId: "run-first",
      jobId: "job-first",
      sourcePath: "/hooks/queue/batch",
      payload: queuedPayload("first"),
      nowMs: createdAtMs,
    });
    enqueueHookQueueItem({
      itemId: "a-second",
      queueId,
      runId: "run-second",
      jobId: "job-second",
      sourcePath: "/hooks/queue/batch",
      payload: queuedPayload("second"),
      nowMs: createdAtMs,
    });
    enqueueHookQueueItem({
      itemId: "m-third",
      queueId,
      runId: "run-third",
      jobId: "job-third",
      sourcePath: "/hooks/queue/batch",
      payload: queuedPayload("third"),
      nowMs: createdAtMs,
    });

    expect(
      [
        claimNextHookQueueItem({ queueId }),
        claimNextHookQueueItem({ queueId }),
        claimNextHookQueueItem({ queueId }),
      ].map((item) => item?.itemId),
    ).toEqual(["z-first", "a-second", "m-third"]);
  });

  test("does not claim queued items while queue is paused", () => {
    const queueId = "batch";
    enqueueHookQueueItem({
      itemId: "queued-paused",
      queueId,
      runId: "run-paused",
      jobId: "job-paused",
      sourcePath: "/hooks/queue/batch",
      payload: queuedPayload("paused"),
      nowMs: 1_000,
    });

    setHookQueuePaused({ queueId, paused: true, nowMs: 2_000 });

    expect(claimNextHookQueueItem({ queueId })).toBeNull();
    expect(summarizeHookQueueItems([queueId])[0]).toMatchObject({
      queueId,
      paused: true,
      pausedAtMs: 2_000,
      counts: { queued: 1, running: 0, ok: 0, error: 0 },
    });

    setHookQueuePaused({ queueId, paused: false, nowMs: 3_000 });

    expect(claimNextHookQueueItem({ queueId })?.itemId).toBe("queued-paused");
    expect(summarizeHookQueueItems([queueId])[0]).toMatchObject({
      queueId,
      paused: false,
      counts: { queued: 0, running: 1, ok: 0, error: 0 },
    });
  });
});
