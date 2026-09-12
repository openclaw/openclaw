// A failed durable admission never delivered anything, so the inbound retry of
// the same message must be admitted again. The message-id reservation is
// released through the turn-adoption lifecycle's abandonment hook — but ordinary
// user requests may carry no lifecycle at all (see get-reply-run-execute.ts), so
// the reservation has to be released independently of lifecycle presence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as followupQueueSqlite from "../../infra/followup-queue-sqlite.js";
import type { QueueSettings } from "./queue.js";
import { clearSessionQueues, enqueueFollowupRun } from "./queue.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { resetRecentQueuedMessageIdDedupe } from "./queue/enqueue.test-support.js";

installQueueRuntimeErrorSilencer();

describe("followup enqueue durable-admission failure", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-enqueue-durable-fail-");
    resetRecentQueuedMessageIdDedupe();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  it.each([
    { label: "without a turn-adoption lifecycle", withLifecycle: false },
    { label: "with a turn-adoption lifecycle", withLifecycle: true },
  ])("re-admits the same message id after a failed durable write $label", ({ withLifecycle }) => {
    const key = `test-durable-fail-${withLifecycle ? "lifecycle" : "bare"}`;
    const route = {
      messageId: "same-id",
      originatingChannel: "telegram",
      originatingTo: "12345",
    };

    const failing = vi
      .spyOn(followupQueueSqlite, "replaceFollowupQueueEntries")
      .mockImplementationOnce(() => {
        throw new Error("synthetic SQLite write failure");
      });

    const first = createRun({ prompt: "first", ...route });
    if (withLifecycle) {
      first.turnAdoptionLifecycle = { onAdopted: () => {} };
    }
    // Durable admission fails, so the run is rejected and nothing was queued.
    expect(enqueueFollowupRun(key, first, settings)).toBe(false);
    expect(failing).toHaveBeenCalledTimes(1);
    failing.mockRestore();

    // The ingress retry redelivers the same message id on the same route. It
    // must be admitted instead of being suppressed for the reservation's TTL.
    const retry = createRun({ prompt: "first", ...route });
    if (withLifecycle) {
      retry.turnAdoptionLifecycle = { onAdopted: () => {} };
    }
    expect(enqueueFollowupRun(key, retry, settings)).toBe(true);
    clearSessionQueues([key]);
  });
});
