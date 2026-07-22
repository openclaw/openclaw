import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueueTestRun as createRun } from "../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.js";
import {
  clearFollowupQueuesRestoredFlagForTest,
  clearRestoredPendingDrainKeysForTest,
  persistFollowupQueues,
  restoreFollowupQueues,
} from "../auto-reply/reply/queue/persist.js";
import { FOLLOWUP_QUEUES } from "../auto-reply/reply/queue/state.js";
import type { QueueSettings } from "../auto-reply/reply/queue/types.js";

const enqueueSystemEvent = vi.fn();
const requestHeartbeat = vi.fn();

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent,
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeat,
}));

const { wakeRestoredFollowupQueueSessions } = await import("./server-followup-queue-recovery.js");

describe("wakeRestoredFollowupQueueSessions", () => {
  const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

  beforeEach(() => {
    enqueueSystemEvent.mockClear();
    requestHeartbeat.mockClear();
  });

  afterEach(() => {
    FOLLOWUP_QUEUES.clear();
    clearRestoredPendingDrainKeysForTest();
    clearFollowupQueuesRestoredFlagForTest();
  });

  it("returns zero when no restored followup queues are pending", () => {
    expect(wakeRestoredFollowupQueueSessions()).toBe(0);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("wakes each session that has a non-empty restored followup queue", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-followup-recovery-"));
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const key = `agent:main:telegram:direct:recovery-${Date.now()}`;

    try {
      enqueueFollowupRun(
        key,
        createRun({ prompt: "after restart" }),
        settings,
        "message-id",
        undefined,
        false,
      );
      persistFollowupQueues();
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      expect(wakeRestoredFollowupQueueSessions()).toBe(1);
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("Restored 1 pending followup message"),
        { sessionKey: key },
      );
      expect(requestHeartbeat).toHaveBeenCalledWith({
        source: "followup-queue-restore",
        intent: "immediate",
        reason: "restored-followup-queue",
        sessionKey: key,
      });
    } finally {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
