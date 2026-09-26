import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { onTrustedMessageAuditEventForTest } from "../../audit/message-audit-events.test-support.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { updateDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite.kernel.js";
import { resolveDeliveryQueueStateEnv } from "../delivery-queue-state-context.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import { failDurableDelivery, type DurableDeliveryCompletion } from "./delivery-completion.js";
import * as mediaSpool from "./delivery-queue-media-spool.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { renewDeliveryPlatformSendLease } from "./delivery-queue-platform-lease.js";
import { drainPendingDeliveriesCore, recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import * as queueStorage from "./delivery-queue-storage.js";
import {
  claimDeliveryQueueEntryForTest,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  readQueuedEntry,
} from "./delivery-queue.test-helpers.js";

const resolveAdapter = vi.hoisted(() => vi.fn());
vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelMessageAdapter: resolveAdapter,
}));

describe("exhausted delivery producer recovery", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();

  beforeEach(() => {
    resolveAdapter.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function enqueue(
    id: string,
    requiresProducerClaim = false,
    deliveryCompletion?: DurableDeliveryCompletion,
    payloads: ReplyPayload[] = [{ text: id }],
    maxRetries = 1,
  ) {
    await queueStorage.enqueueDeliveryOnce(
      {
        channel: "directchat",
        to: "recipient",
        payloads,
        requiresProducerClaim,
        deliveryCompletion,
        maxRetries,
      },
      id,
      tmpDir(),
    );
  }

  async function reserveProducer(id: string, completion?: DurableDeliveryCompletion) {
    await enqueue(id, true, completion);
    const claimId = await queueStorage.claimDeliveryPlatformSendAttempt(id, tmpDir());
    if (!claimId) {
      throw new Error("Expected producer custody");
    }
    await queueStorage.reserveDeliveryAttempt(id, 1, tmpDir(), claimId);
    return claimId;
  }

  function setProducerExpiry(id: string, availableAt: number) {
    updateDeliveryQueueEntryInDatabase(
      openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() } }),
      OUTBOUND_DELIVERY_QUEUE_NAME,
      id,
      (entry) => ({
        ...entry,
        availableAt,
      }),
    );
  }

  function queueStatus(id: string) {
    return openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
    })
      .db.prepare("SELECT status FROM delivery_queue_entries WHERE queue_name = ? AND id = ?")
      .get(OUTBOUND_DELIVERY_QUEUE_NAME, id)?.status;
  }

  async function recover(mode: "startup" | "recurring") {
    const log = createRecoveryLog();
    const deliver = vi.fn();
    const options = { cfg: {}, log, deliver, stateDir: tmpDir() };
    if (mode === "startup") {
      await recoverPendingDeliveries(options);
    } else {
      await drainPendingDeliveriesCore({
        ...options,
        drainKey: tmpDir(),
        logLabel: "producer recovery",
        selectEntry: () => ({ match: true, bypassBackoff: false }),
      });
    }
    expect(deliver).not.toHaveBeenCalled();
    return log;
  }

  it.each(["startup", "recurring"] as const)(
    "%s terminalizes expired final reservations and continues to later deliveries",
    async (mode) => {
      await reserveProducer("expired-producer");
      await enqueue("later-control");
      await queueStorage.reserveDeliveryAttempt("later-control", 1, tmpDir());
      setProducerExpiry("expired-producer", Date.now() - 1);
      closeOpenClawStateDatabaseForTest();

      const log = await recover(mode);

      expect(queueStatus("expired-producer")).toBe("failed");
      expect(queueStatus("later-control")).toBe("failed");
      expect(log.error).not.toHaveBeenCalled();
    },
  );

  it.each(["startup", "recurring"] as const)(
    "%s preserves an active producer even when its attempt budget is exhausted",
    async (mode) => {
      const producerClaimId = await reserveProducer("active-producer");
      await recover(mode);
      expect(await queueStorage.loadPendingDelivery("active-producer", tmpDir())).toMatchObject({
        producerClaimId,
        recoveryState: "producer_claimed",
        attemptCount: 1,
      });
    },
  );

  it.each(["startup", "recurring"] as const)(
    "%s cannot terminalize a replacement producer acquired during recovery admission",
    async (mode) => {
      const originalClaim = await reserveProducer("replaced-producer");
      setProducerExpiry("replaced-producer", Date.now() - 1);
      let replacementClaim: string | undefined;
      resolveAdapter.mockReturnValue({
        durableFinal: {
          admitDeferredDelivery: () => {
            replacementClaim = claimDeliveryQueueEntryForTest({
              queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
              id: "replaced-producer",
              stateDir: tmpDir(),
            });
            return { status: "allowed" };
          },
        },
      });

      await recover(mode);

      expect(replacementClaim).toBeTruthy();
      expect(replacementClaim).not.toBe(originalClaim);
      expect(await queueStorage.loadPendingDelivery("replaced-producer", tmpDir())).toMatchObject({
        producerClaimId: replacementClaim,
        recoveryState: "producer_claimed",
        attemptCount: 1,
      });
    },
  );

  async function preparePendingFinal(
    id: string,
    payloads: ReplyPayload[] = [{ text: id }],
    maxRetries = 1,
  ) {
    const now = Date.now();
    const completion = {
      kind: "pending-final" as const,
      deliveryId: id,
      intentId: "pending-final-intent",
      sessionId: "pending-final-session",
      sessionKey: "agent:main:directchat:direct:recipient",
      storePath: path.join(tmpDir(), "sessions.json"),
    };
    await sessionAccessor.replaceSessionEntry(
      { ...completion, env: resolveDeliveryQueueStateEnv(tmpDir()) },
      {
        sessionId: completion.sessionId,
        updatedAt: now,
        pendingFinalDelivery: {
          kind: "replayable",
          text: "pending final",
          context: { channel: "directchat", to: "recipient" },
          createdAt: now,
          intentId: completion.intentId,
          deliveries: [{ id, state: "queued" }],
        },
      },
    );
    await enqueue(id, false, completion, payloads, maxRetries);
    await queueStorage.reserveDeliveryAttempt(id, 1, tmpDir());
    return completion;
  }

  it.each(["startup", "recurring"] as const)(
    "%s retains unfinished owner settlement across a database reopen without another send",
    async (mode) => {
      const id = "unfinished-owner-settlement";
      const completion = await preparePendingFinal(id);
      const fault = vi
        .spyOn(sessionAccessor, "patchSessionEntryCore")
        .mockRejectedValueOnce(new Error("synthetic owner storage unavailable"));

      await recover(mode);
      expect(readQueuedEntry(tmpDir(), id)).toMatchObject({ deliveryCompletion: completion });
      expect(await queueStorage.findDeliveryIntentOwner(id, tmpDir())).toMatchObject({
        status: "failed",
        settlementPending: true,
      });
      expect(await queueStorage.claimDeliveryPlatformSendAttempt(id, tmpDir())).toBeUndefined();
      await expect(queueStorage.reserveDeliveryAttempt(id, 5, tmpDir())).rejects.toThrow(
        "No pending",
      );
      expect(
        sessionAccessor.loadSessionEntry({
          ...completion,
          env: resolveDeliveryQueueStateEnv(tmpDir()),
        })?.pendingFinalDelivery?.deliveries,
      ).toEqual([{ id, state: "queued" }]);
      fault.mockRestore();
      await closeOpenClawAgentDatabasesAsync(tmpDir());
      closeOpenClawAgentDatabasesForTest(tmpDir());
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();

      await recover(mode);
      expect(queueStatus(id)).toBe("failed");
      expect(
        sessionAccessor.loadSessionEntry({
          ...completion,
          env: resolveDeliveryQueueStateEnv(tmpDir()),
        }),
      ).toMatchObject({
        pendingFinalDelivery: { deliveries: [{ id, state: "unknown" }] },
        pendingDeliveryNotice: { intentId: completion.intentId, state: "owed" },
      });
      expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("deliveryCompletion");
    },
  );
  it.each(["startup", "recurring"] as const)(
    "%s settles a producer-claimed entry whose durable completion has gone stale",
    async (mode) => {
      const id = "stale-producer-claimed";
      const now = Date.now();
      const completion = {
        kind: "pending-final" as const,
        deliveryId: id,
        intentId: "stale-intent",
        sessionId: "stale-session",
        sessionKey: "agent:main:directchat:direct:recipient",
        storePath: path.join(tmpDir(), "sessions.json"),
      };
      await sessionAccessor.replaceSessionEntry(
        { ...completion, env: resolveDeliveryQueueStateEnv(tmpDir()) },
        {
          sessionId: completion.sessionId,
          updatedAt: now,
          pendingFinalDelivery: {
            kind: "replayable",
            text: "pending final",
            context: { channel: "directchat", to: "recipient" },
            createdAt: now,
            intentId: completion.intentId,
            deliveries: [],
          },
        },
      );
      // Keep the attempt budget unused to reach completed-owner acknowledgement.
      await enqueue(id, true, completion);
      const claimId = await queueStorage.claimDeliveryPlatformSendAttempt(id, tmpDir());
      if (!claimId) {
        throw new Error("Expected producer custody");
      }
      setProducerExpiry(id, Date.now() - 1);

      await recover(mode);

      expect(queueStatus(id)).toBeUndefined();
    },
  );

  it("preserves suppressed payload outcomes when a rejected delivery resumes owner settlement", async () => {
    const id = "rejected-batch-settlement";
    const completion = await preparePendingFinal(
      id,
      [{ text: "suppressed" }, { text: "rejected" }],
      3,
    );
    const audits: string[] = [];
    const unsubscribe = onTrustedMessageAuditEventForTest((event) => {
      if (event.action === "message.outbound.finished") {
        audits.push(event.outcome);
      }
    });
    const deliver = vi.fn(
      async (params: Parameters<import("./delivery-queue-recovery.js").DeliverFn>[0]) => {
        params.onPayloadDeliveryOutcome?.({
          index: 0,
          status: "suppressed",
          reason: "no_visible_payload",
        });
        vi.spyOn(sessionAccessor, "patchSessionEntryCore").mockRejectedValueOnce(
          new Error("synthetic rejection projection failure"),
        );
        throw new PlatformMessageNotDispatchedError("synthetic permanent rejection", {
          cause: undefined,
          retryable: false,
        });
      },
    );
    const options = { cfg: {}, log: createRecoveryLog(), deliver, stateDir: tmpDir() };
    try {
      await recoverPendingDeliveries(options);
      expect(audits).toEqual([]);
      expect(readQueuedEntry(tmpDir(), id)).toMatchObject({
        settlement: {
          outcome: "failed",
          rejectionError: "synthetic permanent rejection",
          terminals: [
            {
              payloadIndex: 0,
              terminal: { outcome: "suppressed", reasonCode: "no_visible_payload" },
            },
            { payloadIndex: 1, terminal: { outcome: "failed" } },
          ],
        },
      });
      vi.restoreAllMocks();
      await closeOpenClawAgentDatabasesAsync(tmpDir());
      closeOpenClawAgentDatabasesForTest(tmpDir());
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      await recoverPendingDeliveries(options);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(audits).toEqual(["suppressed", "failed"]);
      expect(
        sessionAccessor.loadSessionEntry({
          ...completion,
          env: resolveDeliveryQueueStateEnv(tmpDir()),
        })?.pendingFinalDelivery?.deliveries,
      ).toEqual([{ id, state: "suppressed" }]);
      expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("settlement");
    } finally {
      unsubscribe();
    }
  });
  it.each(["startup", "recurring"] as const)(
    "%s preserves a renewed platform lease when its scan snapshot is expired",
    async (mode) => {
      const id = "renewed-platform-owner";
      const claimId = await reserveProducer(id);
      await queueStorage.markDeliveryPlatformSendAttemptStarted(id, tmpDir(), undefined, claimId);
      const snapshot = await queueStorage.loadUnfinishedDelivery(id, tmpDir());
      if (!snapshot || typeof snapshot.availableAt !== "number") {
        throw new Error("Expected a leased platform snapshot");
      }
      const renewedUntil = await renewDeliveryPlatformSendLease(id, tmpDir(), claimId);
      expect(renewedUntil).toEqual(expect.any(Number));
      if (renewedUntil === undefined) {
        throw new Error("Expected the live platform owner to renew");
      }
      // Fix only the host clock after real worker renewal and before recovery
      // captures its deadline. Expire the detached view, not the authoritative row.
      vi.spyOn(Date, "now").mockReturnValue(renewedUntil - 1);
      vi.spyOn(queueStorage, "loadUnfinishedDelivery").mockResolvedValueOnce({
        ...snapshot,
        availableAt: renewedUntil - 2,
      });
      await recover(mode);
      expect(await queueStorage.loadPendingDelivery(id, tmpDir())).toMatchObject({
        recoveryState: "send_attempt_started",
        platformSendAttemptId: claimId,
        availableAt: renewedUntil,
        retryCount: 0,
        attemptCount: 1,
      });
    },
  );

  it("refuses a retained settlement snapshot after another owner finalized it", async () => {
    const id = "stale-settlement";
    const completion = await preparePendingFinal(id);
    const pending = await queueStorage.loadPendingDelivery(id, tmpDir());
    if (!pending) {
      throw new Error("Expected queued owner");
    }
    const staged = await queueStorage.stageDeliveryFailureSettlement(
      pending,
      { outcome: "failed", error: "exhausted" },
      tmpDir(),
    );
    if (!staged) {
      throw new Error("Expected settlement owner");
    }
    await failDurableDelivery(completion, tmpDir());
    expect(await queueStorage.finalizeDeliveryFailureSettlement(staged, tmpDir())).toBe(true);
    expect(
      await queueStorage.stageDeliveryFailureSettlement(staged, staged.settlement!, tmpDir()),
    ).toBeUndefined();
  });

  it("publishes only one terminal while startup and periodic settlement overlap", async () => {
    const id = "overlapping-settlement";
    await preparePendingFinal(id);
    const entered = createDeferred();
    const release = createDeferred();
    const update = sessionAccessor.patchSessionEntryCore;
    vi.spyOn(sessionAccessor, "patchSessionEntryCore").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return update(...args);
    });
    const audits: string[] = [];
    const unsubscribe = onTrustedMessageAuditEventForTest((event) => {
      if (event.action === "message.outbound.finished") {
        audits.push(event.outcome);
      }
    });
    const startup = recover("startup");
    try {
      await entered.promise;
      await recover("recurring");
      expect(audits).toEqual([]);
    } finally {
      release.resolve();
      await startup;
      unsubscribe();
    }
    expect(audits).toEqual(["failed"]);
    expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("settlement");
  });

  it("retains unfinished settlement and media through schema repair, then releases both", async () => {
    const id = "repair-settlement";
    const artifact = path.join(
      tmpDir(),
      "delivery-queue-media",
      "00000000-0000-4000-8000-000000000001.ogg",
    );
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, "audio-bytes");
    const completion = await preparePendingFinal(id, [{ text: "reply", mediaUrl: artifact }]);
    const fault = vi
      .spyOn(sessionAccessor, "patchSessionEntryCore")
      .mockRejectedValueOnce(new Error("synthetic owner fault"));
    await recover("startup");
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
    });
    database.db
      .prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
      .run("synthetic-older-version");
    await closeOpenClawAgentDatabasesAsync(tmpDir());
    closeOpenClawAgentDatabasesForTest(tmpDir());
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    expect(readQueuedEntry(tmpDir(), id)).toMatchObject({
      recoveryState: "settlement_pending",
      deliveryCompletion: completion,
    });
    await mediaSpool.pruneOrphanedDeliveryQueueMedia({
      stateDir: tmpDir(),
      nowMs: Date.now() + 30 * 24 * 60 * 60_000,
    });
    await expect(fs.readFile(artifact, "utf8")).resolves.toBe("audio-bytes");
    fault.mockRestore();
    await recover("recurring");
    expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("settlement");
    await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the committed terminal outcome when media cleanup fails", async () => {
    const id = "cleanup-after-settlement";
    const completion = await preparePendingFinal(id);
    vi.spyOn(mediaSpool, "releaseSpoolArtifacts").mockRejectedValueOnce(
      new Error("synthetic cleanup fault"),
    );
    const audits: string[] = [];
    const unsubscribe = onTrustedMessageAuditEventForTest((event) => {
      if (event.action === "message.outbound.finished") {
        audits.push(event.outcome);
      }
    });
    try {
      const log = await recover("startup");
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("terminal cleanup failed"));
      expect(audits).toEqual(["failed"]);
      expect(await queueStorage.findDeliveryIntentOwner(id, tmpDir())).toMatchObject({
        status: "failed",
      });
      expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("settlement");
      expect(
        sessionAccessor.loadSessionEntry({
          ...completion,
          env: resolveDeliveryQueueStateEnv(tmpDir()),
        })?.pendingFinalDelivery?.deliveries,
      ).toEqual([{ id, state: "unknown" }]);
    } finally {
      unsubscribe();
    }
  });
});
