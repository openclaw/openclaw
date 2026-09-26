import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as followupQueueSqlite from "../../infra/followup-queue-sqlite.js";
import { followupQueueEntryContainsPrompt } from "../../infra/followup-queue-sqlite.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import {
  enqueueFollowupRun,
  FollowupTerminalDeliveryError,
  scheduleFollowupDrain,
} from "./queue.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import {
  clearFollowupQueuesRestoredFlagForTest,
  clearRestoredPendingDrainKeysForTest,
  restoreFollowupQueues,
} from "./queue/persist.js";
import { FOLLOWUP_QUEUES } from "./queue/state.js";

installQueueRuntimeErrorSilencer();

describe("followup queue failed terminal delivery", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("does not tombstone delivered or replay after a failed final delivery", async () => {
    const tmpDir = tempDirs.make("openclaw-followup-delivery-discard-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = `test-delivery-discard-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const prompt = "undelivered-after-execution";
    const calls: FollowupRun[] = [];

    try {
      await enqueueFollowupRun(
        key,
        createRun({ prompt }),
        settings,
        "message-id",
        undefined,
        false,
      );
      expect(await followupQueueEntryContainsPrompt(key, prompt)).toBe(true);

      scheduleFollowupDrain(key, async (run) => {
        calls.push(run);
        throw new FollowupTerminalDeliveryError("channel send failed");
      });

      await vi.waitFor(() => {
        expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toEqual([]);
      });

      expect(calls).toHaveLength(1);
      expect(await followupQueueEntryContainsPrompt(key, prompt)).toBe(false);

      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      await restoreFollowupQueues();

      expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toEqual([]);
      expect(await followupQueueEntryContainsPrompt(key, prompt)).toBe(false);
    } finally {
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("keeps a single-drain discard in memory when acknowledgement fails and does not re-run it", async () => {
    const tmpDir = tempDirs.make("openclaw-followup-discard-ack-fail-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = `test-delivery-discard-ack-fail-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const prompt = "undelivered-ack-fail";
    const calls: FollowupRun[] = [];
    const originalReplace = followupQueueSqlite.replaceFollowupQueueEntries;
    let failedOnce = false;
    let discardedAtFailure: boolean | undefined;
    const replaceSpy = vi
      .spyOn(followupQueueSqlite, "replaceFollowupQueueEntries")
      .mockImplementation(async (params) => {
        const hasDiscarded = params.entries.some(
          ([entryKey, data]) =>
            entryKey === key && JSON.stringify(data).includes('"discarded":true'),
        );
        if (hasDiscarded && !failedOnce) {
          failedOnce = true;
          discardedAtFailure = (FOLLOWUP_QUEUES.get(key)?.items ?? []).some(
            (item) => item.prompt === prompt && item.discarded === true,
          );
          throw new Error("injected sqlite acknowledgement failure");
        }
        await originalReplace(params);
      });

    try {
      await enqueueFollowupRun(
        key,
        createRun({ prompt }),
        settings,
        "message-id",
        undefined,
        false,
      );
      expect(await followupQueueEntryContainsPrompt(key, prompt)).toBe(true);

      scheduleFollowupDrain(key, async (run) => {
        calls.push(run);
        throw new FollowupTerminalDeliveryError("channel send failed");
      });

      await vi.waitFor(() => {
        expect(failedOnce).toBe(true);
      });
      expect(calls).toHaveLength(1);
      expect(discardedAtFailure).toBe(true);

      await vi.waitFor(() => {
        expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toEqual([]);
      });
      expect(calls).toHaveLength(1);
      expect(await followupQueueEntryContainsPrompt(key, prompt)).toBe(false);

      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      await restoreFollowupQueues();

      expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toEqual([]);
      expect(await followupQueueEntryContainsPrompt(key, prompt)).toBe(false);
    } finally {
      replaceSpy.mockRestore();
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("settles overflow summary sources when acknowledgement fails and does not re-run the summary", async () => {
    const tmpDir = tempDirs.make("openclaw-followup-overflow-ack-fail-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = `test-overflow-ack-fail-${Date.now()}`;
    const settings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const overflowed = "overflowed-first-turn";
    const kept = "kept-second-turn";
    const calls: string[] = [];
    const originalReplace = followupQueueSqlite.replaceFollowupQueueEntries;
    let failedOnce = false;
    const replaceSpy = vi
      .spyOn(followupQueueSqlite, "replaceFollowupQueueEntries")
      .mockImplementation(async (params) => {
        // Fail the write that settles the overflowed source itself.
        const settlesOverflowSource = params.entries.some(([entryKey, data]) => {
          const sources = (data as { summarySources?: Array<Partial<FollowupRun>> }).summarySources;
          return (
            entryKey === key &&
            (sources ?? []).some((source) => source.prompt === overflowed && source.delivered)
          );
        });
        if (settlesOverflowSource && !failedOnce) {
          failedOnce = true;
          throw new Error("injected sqlite acknowledgement failure");
        }
        await originalReplace(params);
      });
    const runner = async (run: FollowupRun) => {
      calls.push(run.prompt);
    };

    try {
      for (const prompt of [overflowed, kept]) {
        expect(
          await enqueueFollowupRun(
            key,
            createRun({ prompt }),
            settings,
            "message-id",
            undefined,
            false,
          ),
        ).toBe(true);
      }
      expect(FOLLOWUP_QUEUES.get(key)?.summarySources.map((source) => source.prompt)).toEqual([
        overflowed,
      ]);

      scheduleFollowupDrain(key, runner);
      await vi.waitFor(() => {
        expect(failedOnce).toBe(true);
      });
      await vi.waitFor(() => {
        const queue = FOLLOWUP_QUEUES.get(key);
        if (queue && !queue.draining) {
          scheduleFollowupDrain(key, runner);
        }
        expect(queue?.items ?? []).toEqual([]);
        expect(queue?.summarySources ?? []).toEqual([]);
      });

      // The summary executed once; the failed settlement write retried only settlement.
      expect(calls.filter((prompt) => prompt !== kept)).toHaveLength(1);
      expect(calls.filter((prompt) => prompt === kept)).toHaveLength(1);

      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      await restoreFollowupQueues();
      expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toEqual([]);
      expect(FOLLOWUP_QUEUES.get(key)?.summarySources ?? []).toEqual([]);
    } finally {
      replaceSpy.mockRestore();
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("keeps collect-drain discards in memory when acknowledgement fails and does not re-run them", async () => {
    const tmpDir = tempDirs.make("openclaw-followup-collect-discard-ack-fail-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = `test-collect-discard-ack-fail-${Date.now()}`;
    const settings: QueueSettings = { mode: "collect", debounceMs: 0, cap: 50 };
    const firstPrompt = "collect-undelivered-first";
    const secondPrompt = "collect-undelivered-second";
    const calls: FollowupRun[] = [];
    const originalReplace = followupQueueSqlite.replaceFollowupQueueEntries;
    let failedOnce = false;
    let discardedAtFailure = 0;
    const replaceSpy = vi
      .spyOn(followupQueueSqlite, "replaceFollowupQueueEntries")
      .mockImplementation(async (params) => {
        const hasDiscarded = params.entries.some(
          ([entryKey, data]) =>
            entryKey === key && JSON.stringify(data).includes('"discarded":true'),
        );
        if (hasDiscarded && !failedOnce) {
          failedOnce = true;
          discardedAtFailure = (FOLLOWUP_QUEUES.get(key)?.items ?? []).filter(
            (item) => item.discarded === true,
          ).length;
          throw new Error("injected sqlite acknowledgement failure");
        }
        await originalReplace(params);
      });

    try {
      await enqueueFollowupRun(
        key,
        createRun({
          prompt: firstPrompt,
          originatingChannel: "telegram",
          originatingTo: "12345",
        }),
        settings,
      );
      await enqueueFollowupRun(
        key,
        createRun({
          prompt: secondPrompt,
          originatingChannel: "telegram",
          originatingTo: "12345",
        }),
        settings,
      );
      expect(await followupQueueEntryContainsPrompt(key, firstPrompt)).toBe(true);
      expect(await followupQueueEntryContainsPrompt(key, secondPrompt)).toBe(true);

      scheduleFollowupDrain(key, async (run) => {
        calls.push(run);
        throw new FollowupTerminalDeliveryError("channel send failed");
      });

      await vi.waitFor(() => {
        expect(failedOnce).toBe(true);
      });
      expect(calls).toHaveLength(1);
      expect(discardedAtFailure).toBe(2);

      await vi.waitFor(() => {
        expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toEqual([]);
      });
      expect(calls).toHaveLength(1);
      expect(await followupQueueEntryContainsPrompt(key, firstPrompt)).toBe(false);
      expect(await followupQueueEntryContainsPrompt(key, secondPrompt)).toBe(false);

      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      await restoreFollowupQueues();

      expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toEqual([]);
      expect(await followupQueueEntryContainsPrompt(key, firstPrompt)).toBe(false);
      expect(await followupQueueEntryContainsPrompt(key, secondPrompt)).toBe(false);
    } finally {
      replaceSpy.mockRestore();
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });
});
