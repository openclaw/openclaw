import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { followupQueueEntryContainsPrompt } from "../../../infra/followup-queue-sqlite.js";
import * as followupQueueSqlite from "../../../infra/followup-queue-sqlite.js";
import { defaultRuntime } from "../../../runtime.js";
import { enqueueFollowupRun } from "./enqueue.js";
import {
  clearFollowupQueuesRestoredFlagForTest,
  clearRestoredPendingDrainKeysForTest,
  persistFollowupQueuesOrThrow,
  restoreFollowupQueues,
} from "./persist.js";
import {
  FOLLOWUP_PERSIST_TEST_KEY as TEST_KEY,
  FOLLOWUP_PERSIST_TEST_SETTINGS as SETTINGS,
  createFollowupPersistTestItem as makeFollowupRun,
  readFollowupPersistQueueEntry as readPersistedQueueEntry,
} from "./persist.test-helpers.js";
import { resetRecentQueuedMessageIdDedupe } from "./recent-message-ids.js";
import { FOLLOWUP_QUEUES, getFollowupQueue } from "./state.js";
import type { FollowupRun } from "./types.js";

const FOLLOWUP_SETTINGS = { ...SETTINGS, mode: "followup" as const, debounceMs: 0 };

function prompts(items: readonly FollowupRun[] | undefined): string[] {
  return (items ?? []).map((item) => item.prompt);
}

/** Persist work, then drop memory and delete authority as a restart would. */
function leavePreviousProcessRow(prompt: string): void {
  const queue = getFollowupQueue(TEST_KEY, SETTINGS);
  queue.items.push(makeFollowupRun(prompt));
  persistFollowupQueuesOrThrow();
  FOLLOWUP_QUEUES.delete(TEST_KEY);
  clearFollowupQueuesRestoredFlagForTest();
}

function busySqlite(): Error {
  return new Error("SQLITE_BUSY: database is locked");
}

function ingressOwnedRun(prompt: string): FollowupRun {
  return {
    ...makeFollowupRun(prompt),
    turnAdoptionLifecycle: { admission: "exclusive", onAdopted: () => {} },
  };
}

function receiptOwnedRun(prompt: string): FollowupRun {
  return {
    ...makeFollowupRun(prompt),
    // Only the receipt probe matters to persistence custody.
    userTurnTranscriptRecorder: {
      getPendingInputMessage: () => ({ role: "user", content: prompt }),
    } as unknown as FollowupRun["userTurnTranscriptRecorder"],
  };
}

describe("followup queue durable custody", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-persist-custody-");
    FOLLOWUP_QUEUES.clear();
    resetRecentQueuedMessageIdDedupe();
    clearRestoredPendingDrainKeysForTest();
    clearFollowupQueuesRestoredFlagForTest();
    clearRuntimeConfigSnapshot();
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    FOLLOWUP_QUEUES.clear();
    clearFollowupQueuesRestoredFlagForTest();
    clearRuntimeConfigSnapshot();
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalEnv;
    }
  });

  it("restores a durable row before a live enqueue claims the same key", () => {
    leavePreviousProcessRow("previous-process work");
    vi.spyOn(followupQueueSqlite, "loadFollowupQueueEntries").mockImplementationOnce(() => {
      throw busySqlite();
    });
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();

    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("fresh work"));
    persistFollowupQueuesOrThrow();

    expect(prompts(queue.items)).toEqual(["previous-process work", "fresh work"]);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "previous-process work")).toBe(true);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "fresh work")).toBe(true);

    // The retried restore must not replay the row the live queue already reconciled.
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBe(queue);
    expect(prompts(queue.items)).toEqual(["previous-process work", "fresh work"]);
  });

  it("rejects admission while the key's row is unreadable, then admits behind it", () => {
    leavePreviousProcessRow("previous-process work");
    vi.spyOn(followupQueueSqlite, "loadFollowupQueueEntries").mockImplementationOnce(() => {
      throw busySqlite();
    });
    vi.spyOn(followupQueueSqlite, "loadFollowupQueueEntry").mockImplementationOnce(() => {
      throw busySqlite();
    });
    restoreFollowupQueues();
    const enqueue = () =>
      enqueueFollowupRun(
        TEST_KEY,
        makeFollowupRun("fresh work"),
        FOLLOWUP_SETTINGS,
        "message-id",
        undefined,
        false,
      );

    // Accepting now would report success for a turn that no row holds, so a
    // restart before reconciliation would lose it.
    expect(enqueue()).toBe(false);
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "previous-process work")).toBe(true);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "fresh work")).toBe(false);

    // Once the row reads, the retried turn queues durably behind the earlier work.
    expect(enqueue()).toBe(true);
    expect(prompts(FOLLOWUP_QUEUES.get(TEST_KEY)?.items)).toEqual([
      "previous-process work",
      "fresh work",
    ]);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "previous-process work")).toBe(true);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "fresh work")).toBe(true);
  });

  it("keeps turns held by durable ingress or a pending-input receipt out of the snapshot", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(ingressOwnedRun("ingress-owned item"), receiptOwnedRun("receipt-owned item"), {
      ...makeFollowupRun("uncovered gateway item"),
      turnAdoptionLifecycle: { admission: "cancel-only", onAdopted: () => {} },
    });
    queue.summarySources.push(
      ingressOwnedRun("ingress-owned summary"),
      makeFollowupRun("uncovered summary"),
    );
    queue.summaryLines.push("ingress-owned summary", "uncovered summary");
    queue.droppedCount = 2;
    persistFollowupQueuesOrThrow();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: FollowupRun[];
      summarySources: FollowupRun[];
      summaryLines: string[];
    };
    expect(prompts(persisted.items)).toEqual(["uncovered gateway item"]);
    expect(prompts(persisted.summarySources)).toEqual(["uncovered summary"]);
    expect(persisted.summaryLines).toEqual(["uncovered summary"]);

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(prompts(restored?.items)).toEqual(["uncovered gateway item"]);
    expect(prompts(restored?.summarySources)).toEqual(["uncovered summary"]);
  });

  it("does not write sender-bound channel turns, so a revoked sender cannot replay them", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    const senderBound = makeFollowupRun("sender-bound turn");
    senderBound.run = { ...senderBound.run, senderId: "telegram-user-1", senderName: "Ada" };
    queue.items.push(senderBound, makeFollowupRun("sender-free turn"));
    persistFollowupQueuesOrThrow();

    expect(followupQueueEntryContainsPrompt(TEST_KEY, "sender-bound turn")).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "telegram-user-1")).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "sender-free turn")).toBe(true);

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();
    expect(prompts(FOLLOWUP_QUEUES.get(TEST_KEY)?.items)).toEqual(["sender-free turn"]);
  });
});
