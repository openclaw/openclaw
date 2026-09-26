import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  followupQueueEntryContainsPrompt,
  listUnreadableFollowupQueueKeys,
} from "../../../infra/followup-queue-sqlite.js";
import * as followupQueueSqlite from "../../../infra/followup-queue-sqlite.js";
import { requireNodeSqlite } from "../../../infra/node-sqlite.js";
import { defaultRuntime } from "../../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
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
import { FOLLOWUP_QUEUES, getFollowupQueue, retireFollowupQueueForRestart } from "./state.js";
import type { FollowupRun } from "./types.js";

const FOLLOWUP_SETTINGS = { ...SETTINGS, mode: "followup" as const, debounceMs: 0 };

function prompts(items: readonly FollowupRun[] | undefined): string[] {
  return (items ?? []).map((item) => item.prompt);
}

/** Persist work, then drop memory and delete authority as a restart would. */
async function leavePreviousProcessRow(prompt: string): Promise<void> {
  const queue = await getFollowupQueue(TEST_KEY, SETTINGS);
  queue.items.push(makeFollowupRun(prompt));
  await persistFollowupQueuesOrThrow();
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

  it("restores a durable row before a live enqueue claims the same key", async () => {
    await leavePreviousProcessRow("previous-process work");
    vi.spyOn(followupQueueSqlite, "loadFollowupQueueEntries").mockImplementationOnce(() => {
      throw busySqlite();
    });
    await restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();

    const queue = await getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("fresh work"));
    await persistFollowupQueuesOrThrow();

    expect(prompts(queue.items)).toEqual(["previous-process work", "fresh work"]);
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "previous-process work")).toBe(true);
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "fresh work")).toBe(true);

    // The retried restore must not replay the row the live queue already reconciled.
    await restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBe(queue);
    expect(prompts(queue.items)).toEqual(["previous-process work", "fresh work"]);
  });

  it("rejects admission while the key's row is unreadable, then admits behind it", async () => {
    await leavePreviousProcessRow("previous-process work");
    vi.spyOn(followupQueueSqlite, "loadFollowupQueueEntries").mockImplementationOnce(() => {
      throw busySqlite();
    });
    vi.spyOn(followupQueueSqlite, "loadFollowupQueueEntry").mockImplementationOnce(() => {
      throw busySqlite();
    });
    await restoreFollowupQueues();
    const enqueue = async () =>
      await enqueueFollowupRun(
        TEST_KEY,
        makeFollowupRun("fresh work"),
        FOLLOWUP_SETTINGS,
        "message-id",
        undefined,
        false,
      );

    // Accepting now would report success for a turn that no row holds, so a
    // restart before reconciliation would lose it.
    expect(await enqueue()).toBe(false);
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "previous-process work")).toBe(true);
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "fresh work")).toBe(false);

    // Once the row reads, the retried turn queues durably behind the earlier work.
    expect(await enqueue()).toBe(true);
    expect(prompts(FOLLOWUP_QUEUES.get(TEST_KEY)?.items)).toEqual([
      "previous-process work",
      "fresh work",
    ]);
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "previous-process work")).toBe(true);
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "fresh work")).toBe(true);
  });

  it("rejects admission for a key whose row bulk restore could not decode", async () => {
    const corruptKey = "agent:main:dm:corrupt-row";
    await leavePreviousProcessRow("previous-process work");
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(resolveOpenClawStateSqlitePath());
    try {
      db.prepare(
        "INSERT INTO followup_queue_entries(queue_key, queue_json, updated_at) VALUES (?, ?, ?)",
      ).run(corruptKey, "{not-json", Date.now());
    } finally {
      db.close();
    }

    // Bulk restore skips the corrupt row but still completes for readable rows.
    await restoreFollowupQueues();
    expect(prompts(FOLLOWUP_QUEUES.get(TEST_KEY)?.items)).toEqual(["previous-process work"]);

    // Upserting a fresh queue over the retained row would replace content no
    // one has read, so admission for that key stays rejected.
    const admitted = await enqueueFollowupRun(
      corruptKey,
      makeFollowupRun("fresh work"),
      FOLLOWUP_SETTINGS,
      "message-id",
      undefined,
      false,
    );
    expect(admitted).toBe(false);
    expect(FOLLOWUP_QUEUES.has(corruptKey)).toBe(false);
    expect(await listUnreadableFollowupQueueKeys()).toContain(corruptKey);
    expect(await followupQueueEntryContainsPrompt(corruptKey, "fresh work")).toBe(false);
  });

  it("keeps turns held by durable ingress or a pending-input receipt out of the snapshot", async () => {
    const queue = await getFollowupQueue(TEST_KEY, SETTINGS);
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
    await persistFollowupQueuesOrThrow();

    const persisted = (await readPersistedQueueEntry(TEST_KEY)) as {
      items: FollowupRun[];
      summarySources: FollowupRun[];
      summaryLines: string[];
    };
    expect(prompts(persisted.items)).toEqual(["uncovered gateway item"]);
    expect(prompts(persisted.summarySources)).toEqual(["uncovered summary"]);
    expect(persisted.summaryLines).toEqual(["uncovered summary"]);

    // The filtered ingress-owned source must leave droppedCount with it. A
    // restored queue that still owes a drop it cannot deliver never reaches
    // zero, and the empty queue reschedules forever.
    expect((persisted as unknown as { droppedCount: number }).droppedCount).toBe(1);

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    await restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(prompts(restored?.items)).toEqual(["uncovered gateway item"]);
    expect(prompts(restored?.summarySources)).toEqual(["uncovered summary"]);
    expect(restored?.droppedCount).toBe(1);
  });

  it("does not write sender-bound channel turns, so a revoked sender cannot replay them", async () => {
    const queue = await getFollowupQueue(TEST_KEY, SETTINGS);
    const senderBound = makeFollowupRun("sender-bound turn");
    senderBound.run = { ...senderBound.run, senderId: "telegram-user-1", senderName: "Ada" };
    queue.items.push(senderBound, makeFollowupRun("sender-free turn"));
    await persistFollowupQueuesOrThrow();

    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "sender-bound turn")).toBe(false);
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "telegram-user-1")).toBe(false);
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "sender-free turn")).toBe(true);

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    await restoreFollowupQueues();
    expect(prompts(FOLLOWUP_QUEUES.get(TEST_KEY)?.items)).toEqual(["sender-free turn"]);
  });

  it("admits excluded work while shared SQLite is unavailable", async () => {
    // Sender-bound, incognito and operator-bound turns are never written, so a
    // locked or unreachable database must not reject their memory-only enqueue.
    const senderBound = makeFollowupRun("sender-bound during outage");
    senderBound.run = { ...senderBound.run, senderId: "telegram-user-outage" };
    vi.spyOn(followupQueueSqlite, "replaceFollowupQueueEntries").mockImplementation(async () => {
      throw busySqlite();
    });

    const admitted = await enqueueFollowupRun(TEST_KEY, senderBound, FOLLOWUP_SETTINGS);

    expect(admitted).not.toBe(false);
    expect(prompts(FOLLOWUP_QUEUES.get(TEST_KEY)?.items)).toEqual(["sender-bound during outage"]);
  });

  it("admits a first-use excluded queue while shared SQLite is unreadable", async () => {
    // The earlier best-effort write does not help here: materializing a new
    // queue is itself what reads the durable row, so an unreadable store would
    // reject the very first sender-bound turn for this key.
    const senderBound = makeFollowupRun("first-use sender-bound");
    senderBound.run = { ...senderBound.run, senderId: "telegram-user-first-use" };
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    vi.spyOn(followupQueueSqlite, "loadFollowupQueueEntry").mockImplementation(() => {
      throw busySqlite();
    });

    const admitted = await enqueueFollowupRun(TEST_KEY, senderBound, FOLLOWUP_SETTINGS);

    expect(admitted).not.toBe(false);
    expect(prompts(FOLLOWUP_QUEUES.get(TEST_KEY)?.items)).toEqual(["first-use sender-bound"]);
  });

  it("keeps operator-authority-bound turns out of the snapshot entirely", async () => {
    const queue = await getFollowupQueue(TEST_KEY, SETTINGS);
    const operatorBound = makeFollowupRun("operator-authority turn");
    // A live capability: assertCurrent() is what rejects a revoked device or a
    // reassigned operator role before the turn reaches model, tools, or channel.
    operatorBound.operatorAuthority = {
      profileId: "operator-1",
      scopes: ["chat.send"],
      assertCurrent: () => {},
    };
    queue.items.push(operatorBound, makeFollowupRun("authority-free turn"));
    await persistFollowupQueuesOrThrow();

    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "operator-authority turn")).toBe(false);
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "operator-1")).toBe(false);
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "authority-free turn")).toBe(true);

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    await restoreFollowupQueues();
    // Restoring it would hand back a turn whose assertCurrent() is now a no-op.
    expect(prompts(FOLLOWUP_QUEUES.get(TEST_KEY)?.items)).toEqual(["authority-free turn"]);
  });

  it("keeps a restart-retired row for startup recovery instead of replaying it here", async () => {
    const queue = await getFollowupQueue(TEST_KEY, FOLLOWUP_SETTINGS);
    queue.items.push(makeFollowupRun("retired before restart"));
    await persistFollowupQueuesOrThrow();

    retireFollowupQueueForRestart(TEST_KEY);

    // Retirement completes the queued lifecycles here, so the row is the next
    // process's to replay: it survives, and this process never reads it back.
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "retired before restart")).toBe(true);
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();

    await enqueueFollowupRun(TEST_KEY, makeFollowupRun("after retirement"), FOLLOWUP_SETTINGS);
    expect(prompts(FOLLOWUP_QUEUES.get(TEST_KEY)?.items)).toEqual(["after retirement"]);

    // Post-retirement work stays in memory rather than replacing the handoff row.
    await persistFollowupQueuesOrThrow();
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "retired before restart")).toBe(true);
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "after retirement")).toBe(false);
  });
});
