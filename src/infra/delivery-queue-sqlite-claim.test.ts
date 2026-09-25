import { describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createInitialDeliveryProducerClaim } from "./delivery-queue-sqlite-claim.js";
import {
  dispatchDeliveryQueueEntryPlatformSendInDatabase,
  promoteDeliveryQueueEntryPlatformSendInDatabase,
  transitionOwnedDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite-claim.kernel.js";
import { getDeliveryQueueEntryStatus, loadDeliveryQueueEntry } from "./delivery-queue-sqlite.js";
import {
  completeDeliveryQueueEntryInDatabase,
  deleteDeliveryQueueEntryInDatabase,
  upsertDeliveryQueueEntryInDatabase,
  reserveDeliveryQueueEntryAttemptInDatabase,
  updateDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite.kernel.js";
import { seedDeliveryQueueEntry } from "./delivery-queue-sqlite.test-support.js";
import {
  claimDeliveryQueueEntryForTest,
  renewDeliveryQueueEntryLeaseForTest,
  installDeliveryQueueTmpDirHooks,
} from "./outbound/delivery-queue.test-helpers.js";

describe("delivery queue SQLite dispatch ownership", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const queueName = "test-dispatch-owner";
  const openTestDatabase = (stateDir: string) =>
    openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } });
  const reserveAttempt = (
    params: Parameters<typeof reserveDeliveryQueueEntryAttemptInDatabase>[1] & { stateDir: string },
  ) =>
    runOpenClawStateWriteTransaction(
      (database) => reserveDeliveryQueueEntryAttemptInDatabase(database, params),
      { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
    );

  it.each([false, true])(
    "keeps owned settlement and its sibling row atomic after reopen (rollback=%s)",
    (rollback) => {
      const stateDir = tmpDir();
      const entry = { id: "owned-settlement", enqueuedAt: 1, retryCount: 0 };
      const sibling = { ...entry, id: "settlement-receipt" };
      seedDeliveryQueueEntry({ queueName, entry, stateDir });

      const settle = () =>
        transitionOwnedDeliveryQueueEntryInDatabase(
          openTestDatabase(stateDir),
          { queueName, id: entry.id, platformSendAttemptId: null },
          (current, database) => {
            upsertDeliveryQueueEntryInDatabase({ queueName, entry: sibling }, database);
            completeDeliveryQueueEntryInDatabase(database, queueName, current.id);
            if (rollback) {
              throw new Error("settlement rejected");
            }
          },
        );
      if (rollback) {
        expect(settle).toThrow("settlement rejected");
      } else {
        expect(settle()).toBe(true);
      }

      closeOpenClawStateDatabaseForTest();
      expect(getDeliveryQueueEntryStatus(queueName, entry.id, stateDir)).toBe(
        rollback ? "pending" : "completed",
      );
      expect(loadDeliveryQueueEntry(queueName, sibling.id, stateDir)).toEqual(
        rollback ? null : sibling,
      );
    },
  );

  it.each(["producer_claimed", "send_attempt_started", "unknown_after_send"] as const)(
    "preserves the retry budget when a %s claim expires before reservation",
    (recoveryState) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-08-28T10:00:00.000Z"));
        const initialClaim = createInitialDeliveryProducerClaim();
        const params = { queueName, id: "expiring-reservation", stateDir: tmpDir() };
        const claimed = { ...params, claimId: initialClaim.producerClaimId };
        const reservation = {
          ...params,
          maxAttempts: 2,
          expectedPlatformSendAttemptId: claimed.claimId,
        };
        seedDeliveryQueueEntry({
          ...params,
          entry: { id: params.id, enqueuedAt: Date.now(), retryCount: 0, ...initialClaim },
        });
        if (recoveryState !== "producer_claimed") {
          expect(
            dispatchDeliveryQueueEntryPlatformSendInDatabase(
              openTestDatabase(claimed.stateDir),
              claimed,
            ),
          ).toBe(true);
          if (recoveryState === "unknown_after_send") {
            updateDeliveryQueueEntryInDatabase(
              openTestDatabase(params.stateDir),
              queueName,
              params.id,
              (entry) => ({
                ...entry,
                recoveryState,
              }),
            );
          }
          expect(
            promoteDeliveryQueueEntryPlatformSendInDatabase(
              openTestDatabase(claimed.stateDir),
              claimed,
            ),
          ).toBe(false);
        }
        expect(reserveAttempt(reservation)).toEqual({
          status: "reserved",
          attemptCount: 1,
        });

        vi.setSystemTime(initialClaim.availableAt);
        expect(() => reserveAttempt(reservation)).toThrow("claim was lost");
        expect(loadDeliveryQueueEntry(queueName, params.id, params.stateDir)?.attemptCount).toBe(1);
        expect(renewDeliveryQueueEntryLeaseForTest(claimed)).toBeUndefined();
        expect(
          dispatchDeliveryQueueEntryPlatformSendInDatabase(
            openTestDatabase(claimed.stateDir),
            claimed,
          ),
        ).toBe(false);
        if (recoveryState === "producer_claimed") {
          const replacement = claimDeliveryQueueEntryForTest(params);
          expect(replacement).toEqual(expect.any(String));
          expect(() => reserveAttempt(reservation)).toThrow("claim was lost");
          expect(
            reserveAttempt({
              ...reservation,
              expectedPlatformSendAttemptId: replacement,
            }),
          ).toEqual({ status: "reserved", attemptCount: 2 });
        } else {
          // Expiry forbids more work, but the exact owner may settle an observed outcome.
          expect(
            transitionOwnedDeliveryQueueEntryInDatabase(
              openTestDatabase(params.stateDir),
              { ...params, platformSendAttemptId: claimed.claimId },
              (_entry, database) => {
                deleteDeliveryQueueEntryInDatabase(database, queueName, params.id);
              },
            ),
          ).toBe(true);
          expect(loadDeliveryQueueEntry(queueName, params.id, params.stateDir)).toBeNull();
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("reserves unclaimed rows and non-renewable platform attempts without adding a lease", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-28T10:00:00.000Z"));
      const params = { queueName, id: "unleased-reservation", stateDir: tmpDir() };
      seedDeliveryQueueEntry({
        ...params,
        entry: { id: params.id, enqueuedAt: Date.now(), retryCount: 0 },
      });
      expect(
        reserveAttempt({
          ...params,
          maxAttempts: 2,
        }),
      ).toEqual({
        status: "reserved",
        attemptCount: 1,
      });
      const claimId = claimDeliveryQueueEntryForTest(params);
      if (!claimId) {
        throw new Error("test invariant: unclaimed delivery must acquire a producer");
      }
      const claimed = { ...params, claimId };
      expect(
        dispatchDeliveryQueueEntryPlatformSendInDatabase(
          openTestDatabase(claimed.stateDir),
          claimed,
        ),
      ).toBe(true);
      vi.advanceTimersByTime(60_001);
      expect(
        reserveAttempt({
          ...params,
          maxAttempts: 2,
          expectedPlatformSendAttemptId: claimId,
        }),
      ).toEqual({ status: "reserved", attemptCount: 2 });
      expect(renewDeliveryQueueEntryLeaseForTest(claimed)).toBeUndefined();
      expect(
        dispatchDeliveryQueueEntryPlatformSendInDatabase(
          openTestDatabase(claimed.stateDir),
          claimed,
        ),
      ).toBe(true);
      expect(
        loadDeliveryQueueEntry(queueName, params.id, params.stateDir)?.availableAt,
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("atomically promotes dispatch ownership and rejects expired or replaced claims", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-10T10:00:00.000Z"));
      const stateDir = tmpDir();
      const id = "cron-direct-delivery:v1:dispatch-owner";
      seedDeliveryQueueEntry({
        queueName,
        entry: {
          id,
          enqueuedAt: Date.now(),
          retryCount: 0,
          completionRetention: {
            idPrefix: "cron-direct-delivery:v1:",
            maxAgeMs: 24 * 60 * 60_000,
            maxEntries: 2,
          },
          requiresProducerClaim: true,
        },
        stateDir,
      });

      const expiredClaimId = claimDeliveryQueueEntryForTest({ queueName, id, stateDir });
      if (!expiredClaimId) {
        throw new Error("test invariant: the first producer claim must be available");
      }
      vi.advanceTimersByTime(60_001);
      expect(
        dispatchDeliveryQueueEntryPlatformSendInDatabase(openTestDatabase(stateDir), {
          queueName,
          id,
          claimId: expiredClaimId,
        }),
      ).toBe(false);

      const claimId = claimDeliveryQueueEntryForTest({ queueName, id, stateDir });
      if (!claimId) {
        throw new Error("test invariant: the replacement producer claim must be available");
      }
      expect(
        dispatchDeliveryQueueEntryPlatformSendInDatabase(openTestDatabase(stateDir), {
          queueName,
          id,
          claimId: expiredClaimId,
        }),
      ).toBe(false);
      expect(
        dispatchDeliveryQueueEntryPlatformSendInDatabase(openTestDatabase(stateDir), {
          queueName,
          id,
          claimId,
          route: { replyToId: "thread-1" },
        }),
      ).toBe(true);
      expect(loadDeliveryQueueEntry(queueName, id, stateDir)).toMatchObject({
        recoveryState: "send_attempt_started",
        platformSendAttemptId: claimId,
        platformSendStartedAt: Date.now(),
        effectiveReplyToId: "thread-1",
        availableAt: Date.now() + 60_000,
      });
      expect(loadDeliveryQueueEntry(queueName, id, stateDir)?.producerClaimId).toBeUndefined();

      vi.advanceTimersByTime(60_001);
      expect(
        dispatchDeliveryQueueEntryPlatformSendInDatabase(openTestDatabase(stateDir), {
          queueName,
          id,
          claimId,
        }),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
