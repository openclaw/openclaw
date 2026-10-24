import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claimOpenClawStateOwnership } from "../../state/openclaw-state-ownership-operations.js";
import {
  deleteTestEnvValue,
  setTestEnvValue,
  withEnv,
  withEnvAsync,
} from "../../test-utils/env.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { createInitialDeliveryProducerClaim } from "../delivery-queue-sqlite-claim.kernel.js";
import {
  captureDeliveryQueueStateContext,
  type DeliveryQueueStateContext,
} from "../delivery-queue-sqlite.js";
import { OpenClawStateExternalOwnershipError } from "../sqlite-lifecycle-errors.js";
import { ackDelivery, retireUnsentDelivery } from "./delivery-queue-ack.js";
import {
  createDeliveryQueueMediaRetention as retainMedia,
  loadDeliveryQueueMediaRetentionSnapshot as readMedia,
} from "./delivery-queue-media-staging.js";
import { renewDeliveryPlatformSendLease as renewLease } from "./delivery-queue-platform-lease.js";
import { withStableDeliveryPreparation as withPreparation } from "./delivery-queue-preparation.js";
import { recoverPendingDeliveries, type DeliverFn } from "./delivery-queue-recovery.js";
import {
  enqueueDelivery,
  enqueuePreparedDeliveryOnce as publishPrepared,
  failDeliveryAfterPlatformSend as failAfterSend,
  findDeliveryIntentOwner,
  findDeliveryIntentOwners,
  loadPendingDelivery,
  markDeliveryPlatformSendDispatched as markDispatched,
  reserveDeliveryAttempt,
} from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  createQueueMedia,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelMessageAdapter: () => undefined,
}));

describe("captured delivery queue state", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();

  function claimState(): DeliveryQueueStateContext {
    const stateDir = tmpDir();
    claimOpenClawStateOwnership("queue-fixture", {
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_SUPERVISOR_MODE: "external",
      },
    });
    return withEnv({ OPENCLAW_SUPERVISOR_MODE: "external" }, () =>
      captureDeliveryQueueStateContext(stateDir),
    );
  }

  const payload = {
    channel: "matrix",
    to: "!synthetic:example",
    payloads: [{ text: "synthetic" }],
  };
  const enqueue = (context: DeliveryQueueStateContext) =>
    enqueueDelivery(payload, undefined, undefined, context);
  const withAmbientState = (otherState: string, run: () => Promise<void>) =>
    withEnvAsync({ OPENCLAW_STATE_DIR: otherState, OPENCLAW_SUPERVISOR_MODE: undefined }, run);
  const expectMissing = (file: string) =>
    expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  const otherState = () => path.join(tmpDir(), "other-state");
  const captureFields = (context: DeliveryQueueStateContext) => [
    context.stateDir,
    context.supervisorMode,
    context.workerContext.admission.databasePath,
    context.workerContext.environment.OPENCLAW_STATE_DIR,
    context.workerContext.environment.OPENCLAW_SUPERVISOR_MODE,
  ];

  it("keeps preparation, retry evidence, and ACK on the captured state after ambient changes", async () => {
    const context = claimState();
    await withAmbientState(otherState(), async () => {
      const id = "captured-intent";
      const claim = createInitialDeliveryProducerClaim();
      const { producerClaimId: claimId } = claim;
      const preparation = await withPreparation(
        {
          id,
          run: async (owner) => {
            await Promise.resolve();
            await owner.beforeFirstModifier();
            await owner.markPrepared();
            const queued = await publishPrepared(
              { ...payload, initialProducerClaim: claim, completionRetention: "permanent" },
              id,
              await owner.current(),
              undefined,
              undefined,
              context,
            );
            owner.markPublished();
            return queued;
          },
        },
        context,
      );
      expect(preparation).toEqual({ status: "claimed", value: { id, created: true } });
      expect(await renewLease(id, undefined, claimId, context)).toBeGreaterThan(Date.now());
      expect(await reserveDeliveryAttempt(id, 2, undefined, claimId, context)).toEqual({
        status: "reserved",
        attemptCount: 1,
      });
      await markDispatched(id, undefined, undefined, claimId, context);
      await failAfterSend(id, "synthetic failure", undefined, claimId, context);
      expect(await loadPendingDelivery(id, undefined, context)).toMatchObject({
        retryCount: 1,
        lastError: "synthetic failure",
        recoveryState: "unknown_after_send",
        platformSendAttemptId: claimId,
      });
      await ackDelivery(id, undefined, { expectedPlatformSendAttemptId: claimId }, context);
      const mainSql = observeMainThreadSql();
      try {
        expect(await findDeliveryIntentOwners([id, "missing", id], undefined, context)).toEqual([
          expect.objectContaining({ status: "completed" }),
          null,
          expect.objectContaining({ status: "completed" }),
        ]);
        mainSql.expectIdle();
      } finally {
        mainSql.restore();
      }
      await expectMissing(otherState());
    });
  });

  it.each(["read", "owners", "ack"] as const)(
    "does not gain external ownership from later ambient mode during %s",
    async (operation) => {
      const external = claimState();
      const id = await enqueue(external);
      const captured = withEnv({ OPENCLAW_SUPERVISOR_MODE: undefined }, () =>
        captureDeliveryQueueStateContext(external.stateDir),
      );
      await withEnvAsync({ OPENCLAW_SUPERVISOR_MODE: "external" }, async () => {
        const result =
          operation === "read"
            ? loadPendingDelivery(id, undefined, captured)
            : operation === "owners"
              ? findDeliveryIntentOwner(id, undefined, captured)
              : ackDelivery(id, undefined, undefined, captured);
        await expect(result).rejects.toBeInstanceOf(OpenClawStateExternalOwnershipError);
        expect(await loadPendingDelivery(id, undefined, external)).not.toBeNull();
      });
    },
  );

  it.each(["custom", "internal"] as const)(
    "settles %s recovery on its captured state without changing public callback input",
    async (route) => {
      const context = claimState();
      const id = await enqueue(context);
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: context.stateDir, OPENCLAW_SUPERVISOR_MODE: "external" },
        async () => {
          const send: DeliverFn = async (params) => {
            expect(params).not.toHaveProperty("deliveryQueueStateContext");
            setTestEnvValue("OPENCLAW_STATE_DIR", otherState());
            deleteTestEnvValue("OPENCLAW_SUPERVISOR_MODE");
            await params.onPlatformSendStart?.({});
            return [{ channel: "matrix", messageId: "synthetic-result" }];
          };
          const custom = vi.fn(send);
          const internal = vi.fn(
            async (params: Parameters<DeliverFn>[0], captured: DeliveryQueueStateContext) => {
              expect(captureFields(captured)).toEqual(captureFields(context));
              return send(params);
            },
          );
          const summary = await recoverPendingDeliveries(
            { cfg: {}, log: createRecoveryLog(), deliver: custom },
            route === "internal" ? internal : undefined,
          );
          expect(summary).toMatchObject({ recovered: 1, failed: 0 });
          expect([custom.mock.calls.length, internal.mock.calls.length]).toEqual(
            route === "custom" ? [1, 0] : [0, 1],
          );
          if (route === "custom") {
            expect(custom.mock.calls[0]).toHaveLength(1);
          }
          expect(await loadPendingDelivery(id, undefined, context)).toBeNull();
          await expectMissing(otherState());
        },
      );
    },
  );

  it("retains captured state through late cleanup of an unsent media owner", async () => {
    const context = claimState();
    const artifact = await createQueueMedia(context.stateDir, "000000000001", "synthetic audio");
    const stage = await retainMedia([artifact], "outbound-media-stage", undefined, context);
    const claim = createInitialDeliveryProducerClaim();
    const id = await enqueueDelivery(
      { ...payload, payloads: [{ mediaUrl: artifact }], initialProducerClaim: claim },
      undefined,
      stage,
      context,
    );
    const release = await retireUnsentDelivery(
      { id, producerClaimId: claim.producerClaimId },
      context,
    );
    expect(release).toBeTypeOf("function");
    expect(await fs.readFile(artifact, "utf8")).toBe("synthetic audio");
    await withAmbientState(otherState(), async () => {
      await release?.();
      expect(await loadPendingDelivery(id, undefined, context)).toBeNull();
      expect((await readMedia({ expireBeforeMs: 0 }, context)).stagedArtifacts).toEqual([]);
      await expectMissing(artifact);
    });
  });
});
