import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { QueueSettings } from "./queue.js";
import { enqueueFollowupRun } from "./queue.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { kickFollowupDrainIfIdle, rememberFollowupDrainCallback } from "./queue/drain.js";
import {
  clearFollowupQueuesRestoredFlagForTest,
  clearRestoredPendingDrainKeysForTest,
  resolveFollowupQueueStatePath,
  restoreFollowupQueues,
} from "./queue/persist.js";
import { FOLLOWUP_QUEUES } from "./queue/state.js";

installQueueRuntimeErrorSilencer();

// End-to-end persistence round-trip over the real on-disk state file. This is
// the closest in-process reproduction of the production scenario the followup
// queue guards: a channel message queued mid-turn, a gateway crash, and
// exactly-once redelivery on restart. The trigger (enqueue while a run is
// active) is lane-serialized in the live gateway and only reachable from inside
// the process, so the cycle is exercised here against the real persist/restore
// modules rather than over a live transport.
describe("followup queue restart round-trip (real on-disk state file)", () => {
  it("persists a mid-turn Telegram followup, restores it after a simulated restart, redelivers exactly once with routing intact, and does not replay after a second restart", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-followup-tg-restart-"));
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = "agent:main:telegram:direct:6300969793";
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const statePath = resolveFollowupQueueStatePath();

    // A real gateway crash/SIGKILL keeps only the on-disk state file; everything
    // else (in-memory queues, restore-once flag, pending-drain set) is gone.
    const simulateGatewayRestart = () => {
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
    };

    try {
      // Hermetic start: CI runs this shard non-isolated, so FOLLOWUP_QUEUES and
      // the restore-once flag are shared across files. Reset our slice first so
      // a sibling test's leftover queue entry can't bleed into our assertions.
      simulateGatewayRestart();

      // 1. Mid-turn enqueue: a Telegram message arrives while a run is active.
      //    restartIfIdle=false mirrors agent-runner's enqueue-followup call,
      //    which queues the message behind the active turn instead of draining.
      enqueueFollowupRun(
        key,
        createRun({
          prompt: "summarize the thread so far",
          messageId: "tg-3987",
          originatingChannel: "telegram",
          originatingTo: "6300969793",
          originatingAccountId: "default",
        }),
        settings,
        "message-id",
        undefined,
        false,
      );

      // 2. persistFollowupQueues ran synchronously on enqueue: the state file
      //    exists on disk and carries the Telegram routing needed to redeliver.
      expect(fs.existsSync(statePath)).toBe(true);
      const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
        entries: [
          string,
          { items: { prompt: string; originatingChannel?: string; originatingTo?: string }[] },
        ][];
      };
      const persistedEntry = persisted.entries.find(([entryKey]) => entryKey === key);
      const persistedItem = persistedEntry?.[1]?.items[0];
      expect(persistedItem?.prompt).toBe("summarize the thread so far");
      expect(persistedItem?.originatingChannel).toBe("telegram");
      expect(persistedItem?.originatingTo).toBe("6300969793");

      // 3. Crash + restart: wipe process memory; only the disk file survives.
      simulateGatewayRestart();
      expect(FOLLOWUP_QUEUES.has(key)).toBe(false);

      // 4. restoreFollowupQueues reloads the queue from disk, routing intact.
      restoreFollowupQueues();
      const restored = FOLLOWUP_QUEUES.get(key);
      expect(restored?.items).toHaveLength(1);
      expect(restored?.items[0]?.prompt).toBe("summarize the thread so far");
      expect(restored?.items[0]?.originatingChannel).toBe("telegram");
      expect(restored?.items[0]?.originatingTo).toBe("6300969793");

      // 5. Drain via the idle-aware path; record every delivery to detect replay.
      const deliveries: string[] = [];
      rememberFollowupDrainCallback(key, async (run) => {
        deliveries.push(run.prompt);
      });
      kickFollowupDrainIfIdle(key);

      // Wait for the drain to fully settle: it delivers, removes the item, and
      // persists the acknowledgement. Poll the on-disk state until our key is
      // gone (or empty) so the no-replay check below sees the acked file.
      const keyDrainedOnDisk = () => {
        if (!fs.existsSync(statePath)) return true;
        const disk = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
          entries?: [string, { items?: unknown[] }][];
        };
        const entry = (disk.entries ?? []).find(([k]) => k === key);
        return !entry || (entry[1]?.items?.length ?? 0) === 0;
      };
      const deadline = Date.now() + 5_000;
      while (!keyDrainedOnDisk() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // 6. Exactly-once: the restored message was redelivered a single time and
      //    the in-memory queue is now empty.
      expect(deliveries).toEqual(["summarize the thread so far"]);
      expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toHaveLength(0);

      // 7. The drain acknowledgement persisted the now-empty queue, so a SECOND
      //    crash + restore must NOT replay the already-delivered message.
      simulateGatewayRestart();
      restoreFollowupQueues();
      expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toHaveLength(0);
    } finally {
      simulateGatewayRestart();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
