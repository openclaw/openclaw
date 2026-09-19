import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claimOpenClawStateOwnership } from "../../state/openclaw-state-ownership-operations.js";
import { OpenClawStateExternalOwnershipError } from "../../state/openclaw-state-ownership.js";
import {
  deleteTestEnvValue,
  setTestEnvValue,
  withEnv,
  withEnvAsync,
} from "../../test-utils/env.js";
import { createInitialDeliveryProducerClaim } from "../delivery-queue-sqlite-claim.js";
import {
  captureDeliveryQueueStateContext,
  type DeliveryQueueStateContext,
} from "../delivery-queue-sqlite.js";
import { ackDelivery, retireUnsentDelivery } from "./delivery-queue-ack.js";
import {
  createDeliveryQueueMediaRetention,
  loadDeliveryQueueMediaRetentionSnapshot,
} from "./delivery-queue-media-staging.js";
import { renewDeliveryPlatformSendLease } from "./delivery-queue-platform-lease.js";
import { withStableDeliveryPreparation } from "./delivery-queue-preparation.js";
import { recoverPendingDeliveries, type DeliverFn } from "./delivery-queue-recovery.js";
import {
  enqueueDelivery,
  enqueuePreparedDeliveryOnce,
  failDeliveryAfterPlatformSend,
  findDeliveryIntentOwner,
  loadPendingDelivery,
  markDeliveryPlatformSendDispatched,
  reserveDeliveryAttempt,
} from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
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

  it("keeps preparation, retry evidence, and ACK on the captured state after ambient changes", async () => {
    const context = claimState();
    const otherState = path.join(tmpDir(), "other-state");
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: otherState, OPENCLAW_SUPERVISOR_MODE: undefined },
      async () => {
        const id = "captured-intent";
        const claim = createInitialDeliveryProducerClaim();
        const preparation = await withStableDeliveryPreparation(
          {
            id,
            run: async (owner) => {
              await Promise.resolve();
              await owner.beforeFirstModifier();
              await owner.markPrepared();
              const queued = await enqueuePreparedDeliveryOnce(
                {
                  channel: "matrix",
                  to: "!synthetic:example",
                  payloads: [{ text: "synthetic" }],
                  initialProducerClaim: claim,
                  completionRetention: "permanent",
                },
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
        expect(
          await renewDeliveryPlatformSendLease(id, undefined, claim.producerClaimId, context),
        ).toBeGreaterThan(Date.now());
        expect(
          await reserveDeliveryAttempt(id, 2, undefined, claim.producerClaimId, context),
        ).toEqual({ status: "reserved", attemptCount: 1 });
        await markDeliveryPlatformSendDispatched(
          id,
          undefined,
          undefined,
          claim.producerClaimId,
          context,
        );
        await failDeliveryAfterPlatformSend(
          id,
          "synthetic failure",
          undefined,
          claim.producerClaimId,
          context,
        );
        expect(await loadPendingDelivery(id, undefined, context)).toMatchObject({
          retryCount: 1,
          lastError: "synthetic failure",
          recoveryState: "unknown_after_send",
          platformSendAttemptId: claim.producerClaimId,
        });
        await ackDelivery(
          id,
          undefined,
          { expectedPlatformSendAttemptId: claim.producerClaimId },
          context,
        );
        expect(findDeliveryIntentOwner(id, undefined, context)).toMatchObject({
          status: "completed",
        });
        await expect(fs.stat(otherState)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });

  it.each(["read", "ack"] as const)(
    "does not gain external ownership from later ambient mode during %s",
    async (operation) => {
      const external = claimState();
      const id = await enqueueDelivery(
        { channel: "matrix", to: "!synthetic:example", payloads: [{ text: "synthetic" }] },
        undefined,
        undefined,
        external,
      );
      const captured = withEnv({ OPENCLAW_SUPERVISOR_MODE: undefined }, () =>
        captureDeliveryQueueStateContext(external.stateDir),
      );
      await withEnvAsync({ OPENCLAW_SUPERVISOR_MODE: "external" }, async () => {
        const result =
          operation === "read"
            ? loadPendingDelivery(id, undefined, captured)
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
      const id = await enqueueDelivery(
        { channel: "matrix", to: "!synthetic:example", payloads: [{ text: "synthetic" }] },
        undefined,
        undefined,
        context,
      );
      const otherState = path.join(tmpDir(), "other-state");
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: context.stateDir, OPENCLAW_SUPERVISOR_MODE: "external" },
        async () => {
          const send: DeliverFn = async (params) => {
            expect(params).not.toHaveProperty("deliveryQueueStateContext");
            setTestEnvValue("OPENCLAW_STATE_DIR", otherState);
            deleteTestEnvValue("OPENCLAW_SUPERVISOR_MODE");
            await params.onPlatformSendStart?.({});
            return [{ channel: "matrix", messageId: "synthetic-result" }];
          };
          const custom = vi.fn(send);
          const internal = vi.fn(
            async (params: Parameters<DeliverFn>[0], captured: DeliveryQueueStateContext) => {
              expect(captured.stateDir).toBe(context.stateDir);
              expect(captured.supervisorMode).toBe(context.supervisorMode);
              expect(captured.workerContext.admission.databasePath).toBe(
                context.workerContext.admission.databasePath,
              );
              expect(captured.workerContext.environment.OPENCLAW_STATE_DIR).toBe(
                context.workerContext.environment.OPENCLAW_STATE_DIR,
              );
              expect(captured.workerContext.environment.OPENCLAW_SUPERVISOR_MODE).toBe(
                context.workerContext.environment.OPENCLAW_SUPERVISOR_MODE,
              );
              return send(params);
            },
          );
          const summary = await recoverPendingDeliveries(
            { cfg: {}, log: createRecoveryLog(), deliver: custom },
            route === "internal" ? internal : undefined,
          );
          expect(summary).toMatchObject({ recovered: 1, failed: 0 });
          if (route === "custom") {
            expect(custom).toHaveBeenCalledOnce();
            expect(custom.mock.calls[0]).toHaveLength(1);
            expect(internal).not.toHaveBeenCalled();
          } else {
            expect(internal).toHaveBeenCalledOnce();
            expect(custom).not.toHaveBeenCalled();
          }
          expect(await loadPendingDelivery(id, undefined, context)).toBeNull();
          await expect(fs.stat(otherState)).rejects.toMatchObject({ code: "ENOENT" });
        },
      );
    },
  );

  it("retains captured state through late cleanup of an unsent media owner", async () => {
    const context = claimState();
    const artifact = path.join(
      context.stateDir,
      "delivery-queue-media",
      "00000000-0000-4000-8000-000000000001.ogg",
    );
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, "synthetic audio");
    const stage = createDeliveryQueueMediaRetention(
      [artifact],
      "outbound-media-stage",
      undefined,
      undefined,
      context,
    );
    const claim = createInitialDeliveryProducerClaim();
    const id = await enqueueDelivery(
      {
        channel: "matrix",
        to: "!synthetic:example",
        payloads: [{ mediaUrl: artifact }],
        initialProducerClaim: claim,
      },
      undefined,
      stage,
      context,
    );
    const release = retireUnsentDelivery({ id, producerClaimId: claim.producerClaimId }, context);
    expect(release).toBeTypeOf("function");
    expect(await fs.readFile(artifact, "utf8")).toBe("synthetic audio");
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: path.join(tmpDir(), "other-state"),
        OPENCLAW_SUPERVISOR_MODE: undefined,
      },
      async () => {
        await release?.();
        expect(await loadPendingDelivery(id, undefined, context)).toBeNull();
        expect(
          (await loadDeliveryQueueMediaRetentionSnapshot({ expireBeforeMs: 0 }, context))
            .stagedArtifacts,
        ).toEqual([]);
        await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });
});
