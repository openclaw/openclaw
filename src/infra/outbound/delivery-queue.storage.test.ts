// Verifies SQLite-backed outbound queue storage, metadata, failure updates,
// recovery-state markers, and failed-entry moves.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  updateDeliveryQueueEntryInDatabase,
  upsertDeliveryQueueEntryInDatabase,
} from "../delivery-queue-sqlite.kernel.js";
import { runSqliteReadOperationSync } from "../sqlite-schema-facts.js";
import { failPendingDelivery } from "./delivery-queue-ack.js";
import { ackDeliveryInDatabase } from "./delivery-queue-ack.kernel.js";
import { releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { renewDeliveryPlatformSendLease } from "./delivery-queue-platform-lease.js";
import {
  ackDelivery,
  claimDeliveryPlatformSendAttempt,
  enqueueDelivery,
  enqueueDeliveryOnce,
  failDelivery,
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  loadPendingDelivery,
  loadUnfinishedDeliveries,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendDispatched,
  markDeliveryPlatformSendAttemptStarted,
  moveToFailed,
  reserveDeliveryAttempt,
  type QueuedDelivery,
} from "./delivery-queue-storage.js";
import { readOutboundDeliveriesInDatabase } from "./delivery-queue-storage.kernel.js";
import { installDeliveryQueueTmpDirHooks, readQueuedEntry } from "./delivery-queue.test-helpers.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

describe("delivery-queue storage", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const enqueueTextDelivery = (params: Parameters<typeof enqueueDelivery>[0], rootDir = tmpDir()) =>
    enqueueDelivery(params, rootDir);

  it("refreshes empty recovery facts after worker and native writes without publishing rollback", async () => {
    const stateDir = tmpDir();
    const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
    const database = openOpenClawStateDatabase(options);
    const read = () => loadUnfinishedDeliveries(stateDir);
    expect(await read()).toEqual([]);
    expect(await read()).toEqual([]);

    const id = await enqueueTextDelivery({
      channel: "directchat",
      to: "+1555",
      payloads: [{ text: "Queued after an idle poll" }],
    });
    expect((await read()).map((entry) => entry.id)).toEqual([id]);
    const entry = await loadPendingDelivery(id, stateDir);
    if (!entry) {
      throw new Error("Expected pending delivery");
    }
    await ackDelivery(id, stateDir);
    expect(await read()).toEqual([]);
    expect(await read()).toEqual([]);

    expect(() =>
      runOpenClawStateWriteTransaction(
        () => {
          upsertDeliveryQueueEntryInDatabase(
            { queueName: OUTBOUND_DELIVERY_QUEUE_NAME, entry },
            database,
          );
          expect(
            runSqliteReadOperationSync(database.db, () =>
              readOutboundDeliveriesInDatabase(database, { mode: "unfinished" }),
            ).map(({ entry: pending }) => pending.id),
          ).toEqual([id]);
          throw new Error("roll back recovery fixture");
        },
        { ...options, database },
      ),
    ).toThrow("roll back recovery fixture");
    expect(await read()).toEqual([]);

    upsertDeliveryQueueEntryInDatabase(
      { queueName: OUTBOUND_DELIVERY_QUEUE_NAME, entry },
      database,
    );
    expect((await read()).map((pending) => pending.id)).toEqual([id]);
  });

  function readStatus(id: string): string | undefined {
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
    });
    const row = db
      .prepare("SELECT status FROM delivery_queue_entries WHERE queue_name = ? AND id = ?")
      .get(OUTBOUND_DELIVERY_QUEUE_NAME, id) as { status?: string } | undefined;
    return row?.status;
  }

  describe("enqueue + ack lifecycle", () => {
    it("fences stale same-millisecond terminal mutations without releasing newer owner media", async () => {
      const stateDir = tmpDir();
      const id = "cron-direct-delivery:v1:fenced-stale-terminal-media";
      const artifact = path.join(
        stateDir,
        "delivery-queue-media",
        "00000000-0000-4000-8000-000000000090.ogg",
      );
      await fs.mkdir(path.dirname(artifact), { recursive: true });
      await fs.writeFile(artifact, "newer owner still needs these bytes");
      await enqueueDeliveryOnce(
        {
          channel: "directchat",
          to: "+1555",
          payloads: [{ text: "x".repeat(64 * 1024), mediaUrl: artifact, audioAsVoice: true }],
          completionRetention: {
            idPrefix: "cron-direct-delivery:v1:",
            maxAgeMs: 24 * 60 * 60_000,
            maxEntries: 2_000,
          },
        },
        id,
        stateDir,
      );
      const unclaimedSnapshot = await loadPendingDelivery(id, stateDir);
      if (!unclaimedSnapshot) {
        throw new Error("test invariant: the unclaimed bounded row must be readable");
      }
      const firstAttemptId = await claimDeliveryPlatformSendAttempt(id, stateDir);
      if (!firstAttemptId) {
        throw new Error("test invariant: first platform owner must claim the durable row");
      }
      const lostClaim = `Delivery platform claim was lost: ${id}`;
      // Admission snapshots taken before ownership must CAS the unclaimed
      // state; a producer that claimed meanwhile retains its media and row.
      await expect(
        ackDelivery(id, stateDir, { expectedPlatformSendAttemptId: null }),
      ).rejects.toThrow(lostClaim);
      await expect(moveToFailed(id, stateDir, null)).rejects.toThrow(lostClaim);
      await expect(
        failPendingDelivery(
          {
            id,
            entry: unclaimedSnapshot,
          },
          stateDir,
        ),
      ).resolves.toEqual({ status: "not_pending" });
      expect(await fs.readFile(artifact, "utf8")).toBe("newer owner still needs these bytes");
      await markDeliveryPlatformSendAttemptStarted(
        id,
        stateDir,
        { replyToId: null },
        firstAttemptId,
      );
      const sameStartedAt = (await loadPendingDelivery(id, stateDir))?.platformSendStartedAt;
      if (typeof sameStartedAt !== "number") {
        throw new Error("Expected the first worker attempt to record its start time");
      }
      const secondAttemptId = await claimDeliveryPlatformSendAttempt(
        id,
        stateDir,
        sameStartedAt,
        firstAttemptId,
      );
      if (!secondAttemptId) {
        throw new Error("test invariant: reconciled replacement must claim the durable row");
      }
      await markDeliveryPlatformSendAttemptStarted(
        id,
        stateDir,
        { replyToId: null },
        secondAttemptId,
      );
      const fixtureDatabase = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      // Preserve a same-millisecond collision across independent worker attempts.
      updateDeliveryQueueEntryInDatabase(
        fixtureDatabase,
        OUTBOUND_DELIVERY_QUEUE_NAME,
        id,
        (entry) => ({
          ...entry,
          platformSendStartedAt: sameStartedAt,
        }),
      );

      await expect(
        ackDelivery(id, stateDir, { expectedPlatformSendAttemptId: firstAttemptId }),
      ).rejects.toThrow(lostClaim);
      await expect(failDelivery(id, "stale failure", stateDir, firstAttemptId)).rejects.toThrow(
        lostClaim,
      );
      await expect(
        failDeliveryBeforePlatformSend(id, "stale pre-send", stateDir, firstAttemptId),
      ).rejects.toThrow(lostClaim);
      await expect(
        failDeliveryAfterPlatformSend(id, "stale post-send", stateDir, firstAttemptId),
      ).rejects.toThrow(lostClaim);
      await expect(
        markDeliveryPlatformOutcomeUnknown(id, stateDir, firstAttemptId),
      ).rejects.toThrow(lostClaim);
      await expect(
        markDeliveryPlatformSendDispatched(id, stateDir, { replyToId: null }, firstAttemptId),
      ).rejects.toThrow(lostClaim);
      await expect(moveToFailed(id, stateDir, firstAttemptId)).rejects.toThrow(lostClaim);
      await expect(reserveDeliveryAttempt(id, 5, stateDir, firstAttemptId)).rejects.toThrow(
        lostClaim,
      );
      expect(await fs.readFile(artifact, "utf8")).toBe("newer owner still needs these bytes");
      const pending = await loadPendingDelivery(id, stateDir);
      if (!pending) {
        throw new Error("Expected the replacement platform owner to remain pending");
      }
      expect(pending).toMatchObject({
        recoveryState: "send_attempt_started",
        platformSendAttemptId: secondAttemptId,
        platformSendStartedAt: sameStartedAt,
      });
      expect(readStatus(id)).toBe("pending");

      const { db } = fixtureDatabase;
      const retryCount = db.prepare(
        "UPDATE delivery_queue_entries SET retry_count = ? WHERE queue_name = ? AND id = ?",
      );
      retryCount.run(9007199254740992n, OUTBOUND_DELIVERY_QUEUE_NAME, id);
      try {
        let readError: unknown;
        try {
          await loadPendingDelivery(id, stateDir);
        } catch (error) {
          readError = error;
        }
        if (!(readError instanceof Error)) {
          throw new Error("Expected the full pending reader to reject the unsafe integer");
        }
        expect(readError).toMatchObject({ code: "ERR_OUT_OF_RANGE" });
        let ackError: unknown;
        try {
          await ackDelivery(id, stateDir, { expectedPlatformSendAttemptId: secondAttemptId });
        } catch (error) {
          ackError = error;
        }
        expect(ackError).toBeInstanceOf(Error);
        expect(ackError).toMatchObject({
          code: "ERR_OUT_OF_RANGE",
          name: readError.name,
          message: readError.message,
        });
        expect(readStatus(id)).toBe("pending");
        expect(await fs.readFile(artifact, "utf8")).toBe("newer owner still needs these bytes");
      } finally {
        retryCount.run(pending.retryCount, OUTBOUND_DELIVERY_QUEUE_NAME, id);
      }
      const entryTextBytes = Buffer.byteLength(JSON.stringify(readQueuedEntry(stateDir, id)));
      const reads = trackSqliteStatementExecutions(db, ["queue"], (sql) =>
        /^\s*select\b/i.test(sql) && /\bfrom\s+"?delivery_queue_entries"?\b/i.test(sql)
          ? "queue"
          : null,
      );
      try {
        // Count the native kernel's reads; the public ACK now runs in a separate worker.
        const spoolPaths = runOpenClawStateWriteTransaction(
          (database) =>
            ackDeliveryInDatabase(database, id, stateDir, {
              expectedPlatformSendAttemptId: secondAttemptId,
            }),
          { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
        );
        await releaseSpoolArtifacts(spoolPaths, stateDir);
        expect(reads.rowCounts.queue).toBeGreaterThan(0);
        expect(reads.textBytes.queue).toBeGreaterThan(0);
        expect.soft(reads.counts.queue).toBeLessThanOrEqual(3);
        // One full pending row plus the existing compact receipt ownership reads.
        expect.soft(reads.textBytes.queue).toBeLessThan(entryTextBytes + 4096);
      } finally {
        reads.restore();
      }
      expect(readStatus(id)).toBe("completed");
      await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("projects process-local hook metadata out before JSON custody", async () => {
      const id = await enqueueTextDelivery({
        channel: "directchat",
        to: "+1555",
        preparedBatch: {
          schemaVersion: 1,
          sourcePayloadCount: 1,
          entries: [
            {
              sourceIndex: 0,
              status: "suppressed",
              reason: "cancelled_by_message_sending_hook",
              hookEffect: {
                cancelReason: "owned elsewhere",
                metadata: { nonJsonValue: 1n },
              },
            },
          ],
        },
      });

      expect(readQueuedEntry(tmpDir(), id).preparedBatch).toEqual({
        schemaVersion: 1,
        sourcePayloadCount: 1,
        entries: [
          {
            sourceIndex: 0,
            status: "suppressed",
            reason: "cancelled_by_message_sending_hook",
          },
        ],
      });
    });

    it("canonicalizes duplicate singular and plural media before recording fan-out", async () => {
      const mediaUrl = "https://example.com/same.png";
      const id = await enqueueTextDelivery({
        channel: "directchat",
        to: "+1555",
        payloads: [{ text: "caption", mediaUrl, mediaUrls: [mediaUrl] }],
      });

      const entry = readQueuedEntry(tmpDir(), id) as unknown as QueuedDelivery;
      expect(acceptedPreparedOutboundEntries(entry.preparedBatch)[0]?.preparedMediaCount).toBe(1);
    });

    it("atomically reserves delivery attempts up to the producer budget", async () => {
      const id = await enqueueTextDelivery({
        channel: "directchat",
        to: "+1555",
        payloads: [{ text: "attempt-budget" }],
        maxRetries: 2,
      });

      for (const maxAttempts of [0, Number.NaN]) {
        await expect(reserveDeliveryAttempt(id, maxAttempts, tmpDir())).rejects.toThrow(
          `Invalid delivery attempt budget: ${maxAttempts}`,
        );
      }

      await expect(reserveDeliveryAttempt(id, 2, tmpDir())).resolves.toEqual({
        status: "reserved",
        attemptCount: 1,
      });
      await expect(reserveDeliveryAttempt(id, 2, tmpDir())).resolves.toEqual({
        status: "reserved",
        attemptCount: 2,
      });
      await expect(reserveDeliveryAttempt(id, 2, tmpDir())).resolves.toEqual({
        status: "exhausted",
        attemptCount: 2,
      });
      expect(readQueuedEntry(tmpDir(), id).attemptCount).toBe(2);
    });

    it("claimless ack rejects a live-claimed row instead of deleting it", async () => {
      const stateDir = tmpDir();
      const id = await enqueueTextDelivery({
        channel: "directchat",
        to: "+1",
        payloads: [{ text: "claimless-ack-guard" }],
      });
      const attemptId = await claimDeliveryPlatformSendAttempt(id, stateDir);
      if (!attemptId) {
        throw new Error("test invariant: the unclaimed row must accept a platform claim");
      }

      await expect(ackDelivery(id, stateDir)).rejects.toThrow(
        `Delivery platform claim was lost: ${id}`,
      );

      const pending = await loadPendingDelivery(id, stateDir);
      expect(pending).toMatchObject({ id, producerClaimId: attemptId });
      expect(readStatus(id)).toBe("pending");
    });
  });

  describe("failDelivery", () => {
    it("preserves and renews the exact explicit owner after an ambiguous platform outcome", async () => {
      const stateDir = tmpDir();
      const id = "cron-direct-delivery:v1:unknown-owner-lease";
      await enqueueDeliveryOnce(
        {
          channel: "forum",
          to: "123",
          payloads: [{ text: "test" }],
          completionRetention: {
            idPrefix: "cron-direct-delivery:v1:",
            maxAgeMs: 24 * 60 * 60_000,
            maxEntries: 2_000,
          },
          requiresProducerClaim: true,
        },
        id,
        stateDir,
      );
      const claimId = await claimDeliveryPlatformSendAttempt(id, stateDir);
      if (!claimId) {
        throw new Error("test invariant: explicit producer must own the stable row");
      }
      await markDeliveryPlatformSendAttemptStarted(id, stateDir, undefined, claimId);
      const originalExpiry = Date.now() + 10_000;
      updateDeliveryQueueEntryInDatabase(
        openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } }),
        OUTBOUND_DELIVERY_QUEUE_NAME,
        id,
        (entry) => ({
          ...entry,
          availableAt: originalExpiry,
        }),
      );

      await markDeliveryPlatformOutcomeUnknown(id, stateDir, claimId);

      expect(readQueuedEntry(stateDir, id)).toMatchObject({
        recoveryState: "unknown_after_send",
        platformSendAttemptId: claimId,
        availableAt: originalExpiry,
      });
      const beforeRenewal = Date.now();
      const renewedUntil = await renewDeliveryPlatformSendLease(id, stateDir, claimId);
      expect(renewedUntil).toBeGreaterThanOrEqual(beforeRenewal + 60_000);
      expect(renewedUntil).toBeLessThanOrEqual(Date.now() + 60_000);
      expect(readQueuedEntry(stateDir, id).availableAt).toBe(renewedUntil);
    });

    it("keeps ambiguous post-send evidence across a later unclaimed batch dispatch", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "forum",
          to: "123",
          payloads: [{ text: "test" }],
        },
        tmpDir(),
      );

      await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
      await markDeliveryPlatformOutcomeUnknown(id, tmpDir());
      await markDeliveryPlatformSendDispatched(id, tmpDir());

      // Downgrading to send_attempt_started would let recovery replay the whole
      // batch as not_sent and duplicate the payload that already reached the platform.
      expect(readQueuedEntry(tmpDir(), id).recoveryState).toBe("unknown_after_send");
    });

    it("releases a settled live owner while retaining retryable custody", async () => {
      const id = await enqueueTextDelivery({
        channel: "forum",
        to: "123",
        payloads: [{ text: "test" }],
        requiresProducerClaim: true,
      });
      const claimId = await claimDeliveryPlatformSendAttempt(id, tmpDir());
      expect(claimId).toEqual(expect.any(String));

      await failDelivery(id, "provider failed", tmpDir(), claimId);

      expect(readQueuedEntry(tmpDir(), id)).toMatchObject({
        retryCount: 1,
        lastError: "provider failed",
      });
      expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("availableAt");
      expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("producerClaimId");
      expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("recoveryState");
    });

    it("terminalizes a rejected stable row under its exact crash claim", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000);
        const artifact = path.join(
          tmpDir(),
          "delivery-queue-media",
          "00000000-0000-4000-8000-000000000091.ogg",
        );
        await fs.mkdir(path.dirname(artifact), { recursive: true });
        await fs.writeFile(artifact, "private rejected media");
        const id = "stable-rejected-after-crash-claim";
        await enqueueDeliveryOnce(
          {
            channel: "directchat",
            to: "+1555",
            payloads: [{ mediaUrl: artifact, audioAsVoice: true }],
            requiresProducerClaim: true,
          },
          id,
          tmpDir(),
        );
        const claimId = await claimDeliveryPlatformSendAttempt(id, tmpDir());
        if (!claimId) {
          throw new Error("test invariant: stable rejection must own a producer claim");
        }
        vi.setSystemTime(60_000);
        const claimed = await loadPendingDelivery(id, tmpDir());
        if (!claimed) {
          throw new Error("test invariant: claimed delivery must remain pending");
        }

        await expect(failPendingDelivery({ id, entry: claimed }, tmpDir())).resolves.toEqual({
          status: "failed",
        });

        expect(readStatus(id)).toBe("failed");
        expect(readQueuedEntry(tmpDir(), id)).toEqual({
          id,
          enqueuedAt: 60_000,
          failedAt: 60_000,
          retryCount: 0,
          completionRetention: "permanent",
          recoveryState: "completed_permanent",
        });
        await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns a typed no-op when a status race already moved the row", async () => {
      const id = await enqueueTextDelivery({
        channel: "slack",
        to: "C123",
        payloads: [{ text: "blocked" }],
      });
      const entry = await loadPendingDelivery(id, tmpDir());
      if (!entry) {
        throw new Error("expected pending entry");
      }
      await moveToFailed(id, tmpDir());

      await expect(
        failPendingDelivery(
          {
            id,
            entry,
          },
          tmpDir(),
        ),
      ).resolves.toEqual({ status: "not_pending" });
      expect(readStatus(id)).toBeUndefined();
      await expect(
        failPendingDelivery(
          {
            id,
            entry: { ...entry, id: "unused-after-owner-removal" },
            expectedPlatformSendAttemptId: "stale-claim",
          },
          tmpDir(),
        ),
      ).resolves.toEqual({ status: "not_pending" });
    });
  });

  describe("moveToFailed", () => {
    it("retains a minimal stable fence that later producers cannot replace", async () => {
      const id = "stable-failed-delivery";
      await enqueueDeliveryOnce(
        {
          channel: "workspace",
          to: "#general",
          payloads: [{ text: "private stable payload" }],
        },
        id,
        tmpDir(),
      );

      await moveToFailed(id, tmpDir());
      await ackDelivery(id, tmpDir());

      expect(readStatus(id)).toBe("failed");
      expect(readQueuedEntry(tmpDir(), id)).toEqual({
        id,
        enqueuedAt: expect.any(Number),
        failedAt: expect.any(Number),
        retryCount: 0,
        completionRetention: "permanent",
        recoveryState: "completed_permanent",
      });
      await expect(
        enqueueDeliveryOnce(
          { channel: "workspace", to: "#general", payloads: [{ text: "replacement" }] },
          id,
          tmpDir(),
        ),
      ).resolves.toEqual({ id, created: false });
    });
  });
});
