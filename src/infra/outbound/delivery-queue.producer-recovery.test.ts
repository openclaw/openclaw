import fs from "node:fs/promises";
import path from "node:path";
import { assert, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { onTrustedMessageAuditEventForTest } from "../../audit/message-audit-events.test-support.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { updateDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite.kernel.js";
import { resolveDeliveryQueueStateEnv } from "../delivery-queue-state-context.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import * as settlement from "./delivery-completion.js";
import * as mediaSpool from "./delivery-queue-media-spool.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { renewDeliveryPlatformSendLease } from "./delivery-queue-platform-lease.js";
import {
  type DeliverFn,
  drainPendingDeliveriesCore,
  recoverPendingDeliveries,
} from "./delivery-queue-recovery.js";
import * as queue from "./delivery-queue-storage.js";
import {
  claimDeliveryQueueEntryForTest,
  createPendingFinalFixture,
  createQueueMedia,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  readQueuedEntry,
  readQueueStatus,
} from "./delivery-queue.test-helpers.js";

const resolveAdapter = vi.hoisted(() => vi.fn());
vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelMessageAdapter: resolveAdapter,
}));

describe("exhausted delivery producer recovery", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const audits: string[] = [];
  const route = { channel: "directchat", to: "recipient" };
  const sessionKey = "agent:main:directchat:direct:recipient";
  const database = () =>
    openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() } });
  function recoveryOptions(deliver: DeliverFn = vi.fn()) {
    return { cfg: {}, log: createRecoveryLog(), deliver, stateDir: tmpDir() };
  }

  beforeEach(() => {
    resolveAdapter.mockReset();
    audits.length = 0;
    onTrustedMessageAuditEventForTest((event) => {
      if (event.action === "message.outbound.finished") {
        audits.push(event.outcome);
      }
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
  });

  function enqueue(
    id: string,
    overrides: Partial<Parameters<typeof queue.enqueueDeliveryOnce>[0]> = {},
  ) {
    return queue.enqueueDeliveryOnce(
      { ...route, payloads: [{ text: id }], maxRetries: 1, ...overrides },
      id,
      tmpDir(),
    );
  }

  async function reserveProducer(id: string) {
    await enqueue(id, { requiresProducerClaim: true });
    const claimId = await queue.claimDeliveryPlatformSendAttempt(id, tmpDir());
    assert(claimId, "Expected producer custody");
    await queue.reserveDeliveryAttempt(id, 1, tmpDir(), claimId);
    return claimId;
  }

  function setProducerExpiry(id: string, availableAt: number) {
    updateDeliveryQueueEntryInDatabase(database(), OUTBOUND_DELIVERY_QUEUE_NAME, id, (entry) => ({
      ...entry,
      availableAt,
    }));
  }

  const queueStatus = (id: string) => readQueueStatus(tmpDir(), id);

  async function recover(mode: "startup" | "recurring") {
    const options = recoveryOptions();
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
    expect(options.deliver).not.toHaveBeenCalled();
    return options.log;
  }

  it("terminalizes expired final reservations and continues to later deliveries", async () => {
    await reserveProducer("expired-producer");
    await enqueue("later-control");
    await queue.reserveDeliveryAttempt("later-control", 1, tmpDir());
    setProducerExpiry("expired-producer", Date.now() - 1);
    closeOpenClawStateDatabaseForTest();
    const log = await recover("recurring");
    expect(queueStatus("expired-producer")).toBe("failed");
    expect(queueStatus("later-control")).toBe("failed");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("preserves an active producer even when its attempt budget is exhausted", async () => {
    const producerClaimId = await reserveProducer("active-producer");
    await recover("startup");
    expect(await queue.loadPendingDelivery("active-producer", tmpDir())).toMatchObject({
      producerClaimId,
      recoveryState: "producer_claimed",
      attemptCount: 1,
    });
  });

  it("cannot terminalize a replacement producer acquired during recovery admission", async () => {
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
    await recover("recurring");
    expect(replacementClaim).toBeTruthy();
    expect(replacementClaim).not.toBe(originalClaim);
    expect(await queue.loadPendingDelivery("replaced-producer", tmpDir())).toMatchObject({
      producerClaimId: replacementClaim,
      recoveryState: "producer_claimed",
      attemptCount: 1,
    });
  });

  function sessionScope() {
    const storePath = path.join(tmpDir(), "sessions.json");
    return { sessionKey, storePath, env: resolveDeliveryQueueStateEnv(tmpDir()) };
  }
  async function prepareSession(id: string, stale = false) {
    const scope = sessionScope();
    const { completion, entry } = createPendingFinalFixture(scope.storePath, id, scope.sessionKey, {
      now: Date.now(),
      state: "queued",
      stale,
      context: route,
    });
    await sessions.replaceSessionEntry(scope, entry);
    return completion;
  }

  async function preparePendingFinal(
    id: string,
    payloads: ReplyPayload[] = [{ text: id }],
    maxRetries = 1,
  ) {
    const completion = await prepareSession(id);
    await enqueue(id, { deliveryCompletion: completion, payloads, maxRetries });
    await queue.reserveDeliveryAttempt(id, 1, tmpDir());
    return completion;
  }
  const loadSession = () => sessions.loadSessionEntry(sessionScope());

  it("settles a producer-claimed entry whose durable completion has gone stale", async () => {
    const id = "stale-producer-claimed";
    const completion = await prepareSession(id, true);
    // Keep the attempt budget unused to reach completed-owner acknowledgement.
    await enqueue(id, { requiresProducerClaim: true, deliveryCompletion: completion });
    const claimId = await queue.claimDeliveryPlatformSendAttempt(id, tmpDir());
    assert(claimId, "Expected producer custody");
    setProducerExpiry(id, Date.now() - 1);
    await recover("startup");
    expect(queueStatus(id)).toBeUndefined();
  });

  it("preserves suppressed payload outcomes when a rejected delivery resumes owner settlement", async () => {
    const id = "rejected-batch-settlement";
    await preparePendingFinal(id, [{ text: "suppressed" }, { text: "rejected" }], 3);
    const deliver = vi.fn<DeliverFn>(async (params) => {
      params.onPayloadDeliveryOutcome?.({
        index: 0,
        status: "suppressed",
        reason: "no_visible_payload",
      });
      vi.spyOn(settlement, "settleDurableDelivery").mockRejectedValueOnce(
        new Error("synthetic rejection projection failure"),
      );
      throw new PlatformMessageNotDispatchedError("synthetic permanent rejection", {
        cause: undefined,
        retryable: false,
      });
    });
    const options = recoveryOptions(deliver);
    await recoverPendingDeliveries(options);
    expect(audits).toEqual([]);
    expect(readQueuedEntry(tmpDir(), id).settlement).toMatchObject({
      outcome: "failed",
      rejectionError: "synthetic permanent rejection",
      terminals: [
        {
          payloadIndex: 0,
          terminal: { outcome: "suppressed", reasonCode: "no_visible_payload" },
        },
        { payloadIndex: 1, terminal: { outcome: "failed" } },
      ],
    });
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    closeOpenClawAgentDatabasesForTest();
    await recoverPendingDeliveries(options);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(audits).toEqual(["suppressed", "failed"]);
    expect(loadSession()?.pendingFinalDelivery?.deliveries).toEqual([{ id, state: "suppressed" }]);
    expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("settlement");
  });
  it("preserves a renewed platform lease when its scan snapshot is expired", async () => {
    const id = "renewed-platform-owner";
    const claimId = await reserveProducer(id);
    await queue.markDeliveryPlatformSendAttemptStarted(id, tmpDir(), undefined, claimId);
    const snapshot = await queue.loadUnfinishedDelivery(id, tmpDir());
    assert(snapshot && typeof snapshot.availableAt === "number", "Expected leased snapshot");
    const renewedUntil = await renewDeliveryPlatformSendLease(id, tmpDir(), claimId);
    expect(renewedUntil).toEqual(expect.any(Number));
    assert(renewedUntil !== undefined, "Expected platform lease renewal");
    // Fix only the host clock after real worker renewal and before recovery
    // captures its deadline. Expire the detached view, not the authoritative row.
    vi.spyOn(Date, "now").mockReturnValue(renewedUntil - 1);
    vi.spyOn(queue, "loadUnfinishedDelivery").mockResolvedValueOnce({
      ...snapshot,
      availableAt: renewedUntil - 2,
    });
    await recover("startup");
    expect(await queue.loadPendingDelivery(id, tmpDir())).toMatchObject({
      recoveryState: "send_attempt_started",
      platformSendAttemptId: claimId,
      availableAt: renewedUntil,
      retryCount: 0,
      attemptCount: 1,
    });
  });

  it("refuses a retained settlement snapshot after another owner finalized it", async () => {
    const id = "stale-settlement";
    const completion = await preparePendingFinal(id);
    const pending = await queue.loadPendingDelivery(id, tmpDir());
    assert(pending, "Expected queued owner");
    const staged = await queue.stageDeliveryFailureSettlement(
      pending,
      { outcome: "failed", error: "exhausted" },
      tmpDir(),
    );
    assert(staged, "Expected settlement owner");
    await settlement.settleDurableDelivery(completion, { platformSendStarted: true }, tmpDir());
    expect(await queue.finalizeDeliveryFailureSettlement(staged, tmpDir())).toBe(true);
    expect(
      await queue.stageDeliveryFailureSettlement(staged, staged.settlement!, tmpDir()),
    ).toBeUndefined();
  });

  it("publishes only one terminal while startup and periodic settlement overlap", async () => {
    const id = "overlapping-settlement";
    await preparePendingFinal(id);
    const entered = createDeferred();
    const release = createDeferred();
    const settle = settlement.settleDurableDelivery;
    vi.spyOn(settlement, "settleDurableDelivery").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return settle(...args);
    });
    const startup = recover("startup");
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        startup,
        "Recovery finished before entering durable settlement",
      );
      await recover("recurring");
      expect(audits).toEqual([]);
    } finally {
      release.resolve();
      await startup;
    }
    expect(audits).toEqual(["failed"]);
    expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("settlement");
  });

  it("retains unfinished settlement and media through schema repair, then releases both", async () => {
    const id = "repair-settlement";
    const artifact = await createQueueMedia(tmpDir(), "000000000001", "audio-bytes");
    const completion = await preparePendingFinal(id, [{ text: "reply", mediaUrl: artifact }]);
    const fault = vi
      .spyOn(settlement, "settleDurableDelivery")
      .mockRejectedValueOnce(new Error("synthetic owner fault"));
    await recover("startup");
    expect(await queue.findDeliveryIntentOwner(id, tmpDir())).toMatchObject({
      status: "failed",
      settlementPending: true,
    });
    expect(await queue.claimDeliveryPlatformSendAttempt(id, tmpDir())).toBeUndefined();
    await expect(queue.reserveDeliveryAttempt(id, 5, tmpDir())).rejects.toThrow("No pending");
    expect(loadSession()?.pendingFinalDelivery?.deliveries).toEqual([{ id, state: "queued" }]);
    database()
      .db.prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
      .run("synthetic-older-version");
    closeOpenClawStateDatabaseForTest();
    closeOpenClawAgentDatabasesForTest();
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
    expect(queueStatus(id)).toBe("failed");
    expect(loadSession()).toMatchObject({
      pendingFinalDelivery: { deliveries: [{ id, state: "unknown" }] },
      pendingDeliveryNotice: { intentId: completion.intentId, state: "owed" },
    });
    expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("deliveryCompletion");
    expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("settlement");
    await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the committed terminal outcome when media cleanup fails", async () => {
    const id = "cleanup-after-settlement";
    await preparePendingFinal(id);
    vi.spyOn(mediaSpool, "releaseSpoolArtifacts").mockRejectedValueOnce(
      new Error("synthetic cleanup fault"),
    );
    const log = await recover("startup");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("terminal cleanup failed"));
    expect(audits).toEqual(["failed"]);
    expect(await queue.findDeliveryIntentOwner(id, tmpDir())).toMatchObject({ status: "failed" });
    expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("settlement");
    expect(loadSession()?.pendingFinalDelivery?.deliveries).toEqual([{ id, state: "unknown" }]);
  });
});
