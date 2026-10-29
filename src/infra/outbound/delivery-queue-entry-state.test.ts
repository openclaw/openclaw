import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { sendDurableMessageBatch } from "../../plugin-sdk/channel-outbound.js";
import { drainPendingDeliveries } from "../../plugin-sdk/delivery-queue-runtime.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { claimOpenClawStateOwnership } from "../../state/openclaw-state-ownership-operations.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withEnv, withEnvAsync } from "../../test-utils/env.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { createInitialDeliveryProducerClaim } from "../delivery-queue-sqlite-claim.kernel.js";
import { captureDeliveryQueueStateContext } from "../delivery-queue-sqlite.js";
import { OpenClawStateExternalOwnershipError } from "../sqlite-lifecycle-errors.js";
import { deliverOutboundPayloads } from "./deliver.js";
import { ackDelivery, retireUnsentDelivery } from "./delivery-queue-ack.js";
import {
  createDeliveryQueueMediaRetention as retainMedia,
  loadDeliveryQueueMediaRetentionSnapshot as readMedia,
} from "./delivery-queue-media-staging.js";
import { renewDeliveryPlatformSendLease as renewLease } from "./delivery-queue-platform-lease.js";
import { withStableDeliveryPreparation as withPreparation } from "./delivery-queue-preparation.js";
import type { DeliverFn } from "./delivery-queue-recovery.js";
import {
  enqueueDelivery,
  enqueueDeliveryOnce,
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
  readQueuedEntries,
} from "./delivery-queue.test-helpers.js";

describe("delivery queue entry state", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  const target = "reef:synthetic-peer";
  const queueId = "synthetic-entry";
  function expectPublicInput(input: object) {
    expect(input).not.toHaveProperty("deliveryQueueStateContext");
  }

  function root(name: string) {
    const dir = path.join(fixtures.tmpDir(), name);
    fs.mkdirSync(dir);
    return dir;
  }
  function ambient(stateDir: string, mode?: string) {
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", mode);
  }

  function installSender(check: (input: object) => void | Promise<void> = () => {}) {
    const sendText = vi.fn(async (input: object) => {
      await check(input);
      return { channel: "reef" as const, messageId: "sent" };
    });
    const plugin = createOutboundTestPlugin({
      id: "reef",
      outbound: { deliveryMode: "direct", sendText },
    });
    setActivePluginRegistry(createTestRegistry([{ pluginId: "reef", source: "test", plugin }]));
    return sendText;
  }

  const payload = { channel: "reef" as const, to: target, payloads: [{ text: "synthetic" }] };
  const sendInput = {
    ...payload,
    cfg: {},
    queuePolicy: "required" as const,
    requireUnknownSendReconciliation: false,
  };
  function claimRoot(stateDir: string) {
    ambient(stateDir, "external");
    claimOpenClawStateOwnership("queue-fixture", { env: process.env });
    return captureDeliveryQueueStateContext(stateDir);
  }
  const enqueue = (stateDir: string, queuePolicy?: "required") =>
    enqueueDeliveryOnce({ ...payload, queuePolicy }, queueId, stateDir);
  const otherState = () => path.join(fixtures.tmpDir(), "other-state");
  const withAmbientState = (run: () => Promise<void>) =>
    withEnvAsync({ OPENCLAW_STATE_DIR: otherState(), OPENCLAW_SUPERVISOR_MODE: undefined }, run);
  const expectMissing = (file: string) =>
    expect(fs.promises.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  const customDelivery = (check: (input: Parameters<DeliverFn>[0]) => void = () => {}) =>
    vi.fn<DeliverFn>(async (input) => {
      check(input);
      await input.onPlatformSendStart?.({});
      return [{ channel: "reef", messageId: "custom" }];
    });
  const drain = (options: Partial<Parameters<typeof drainPendingDeliveries>[0]>) =>
    drainPendingDeliveries({
      drainKey: "sdk-unprivileged",
      logLabel: "Synthetic SDK reconnect",
      cfg: {},
      log: createRecoveryLog(),
      selectEntry: () => ({ match: true, bypassBackoff: false }),
      ...options,
    });
  async function resumeDrain(options: Parameters<typeof drain>[0], beforeRelease: () => void) {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const pending = drain(options);
    const settled = pending.catch(() => {});
    try {
      await setImmediate();
      beforeRelease();
      expect(suspension?.release()).toBe(true);
      await pending;
    } finally {
      suspension?.release();
      await settled;
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
    resetGatewayWorkAdmission();
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  });

  it.each(["sdk", "public-delivery"] as const)(
    "ignores a recovery-only root and private context for a fresh %s send",
    async (entrypoint) => {
      const originalRoot = root("original");
      const injectedRoot = root("injected");

      vi.stubEnv("OPENCLAW_STATE_DIR", originalRoot);
      installSender((input) => {
        expect(input).not.toHaveProperty("conversationDeliveryTarget");
        expectPublicInput(input);
        expect(readQueuedEntries(originalRoot)).toHaveLength(1);
        expect(readQueuedEntries(injectedRoot)).toEqual([]);
      });
      const injected = {
        ...sendInput,
        durability: "required" as const,
        deliveryIntentId: "public-state-selector",
        conversationDeliveryTarget: {
          agentId: "main",
          databaseAgentId: "main",
          storePath: path.join(injectedRoot, "agent.sqlite"),
          stateDir: injectedRoot,
        },
        deliveryQueueStateContext: { stateDir: injectedRoot },
        deliveryQueueStateDir: injectedRoot,
      };
      if (entrypoint === "sdk") {
        await expect(sendDurableMessageBatch(injected)).resolves.toMatchObject({ status: "sent" });
      } else {
        await expect(deliverOutboundPayloads(injected)).resolves.toMatchObject([
          { messageId: "sent" },
        ]);
      }
    },
  );

  it("retains the default root and supervisor mode through awaited preparation", async () => {
    const originalRoot = root("original");
    const replacementRoot = root("replacement");

    const context = claimRoot(originalRoot);
    installSender(async () => {
      expect(await loadPendingDelivery(queueId, originalRoot, context)).not.toBeNull();
      expect(await loadPendingDelivery(queueId, replacementRoot)).toBeNull();
    });
    const delivery = deliverOutboundPayloads({ ...sendInput, deliveryIntentId: queueId });
    ambient(replacementRoot);
    await expect(delivery).resolves.toMatchObject([{ messageId: "sent" }]);
    expect(await loadPendingDelivery(queueId, originalRoot, context)).toBeNull();
    expect(await loadPendingDelivery(queueId, replacementRoot)).toBeNull();
  });

  it("honors the owned root when resuming an existing queue entry", async () => {
    const originalRoot = root("recovery");
    const ambientRoot = root("ambient");

    vi.stubEnv("OPENCLAW_STATE_DIR", ambientRoot);
    await enqueue(originalRoot, "required");
    installSender(async () => {
      expect(await loadPendingDelivery(queueId, originalRoot)).toMatchObject({
        recoveryState: "send_attempt_started",
      });
    });
    await expect(
      deliverOutboundPayloads({
        ...sendInput,
        skipQueue: true,
        deliveryQueueId: queueId,
        deliveryQueueStateDir: originalRoot,
      }),
    ).resolves.toMatchObject([{ messageId: "sent" }]);
    expect(await loadPendingDelivery(queueId, ambientRoot)).toBeNull();
    await ackDelivery(queueId, originalRoot);
  });

  it.each([
    ["default", "custom"],
    ["relative", "builtin"],
    ["home-relative", "custom"],
  ] as const)(
    "captures the SDK %s root before admission and lazy delivery for a %s callback",
    async (locator, callback) => {
      const originalDirectory = root("original");
      const originalRoot = path.join(originalDirectory, "queue");
      const replacementDirectory = root("replacement");
      fs.mkdirSync(originalRoot, { recursive: true });

      vi.stubEnv("OPENCLAW_HOME", originalDirectory);
      const context = claimRoot(originalRoot);
      const generation = {
        agentId: "main",
        storePath: path.join(originalRoot, "agent-sessions.json"),
        sessionKey: "agent:main:dashboard:queued",
        sessionId: "queued-session",
        lifecycleRevision: "queued-lifecycle",
      };
      await replaceSessionEntry(generation, {
        sessionId: generation.sessionId,
        lifecycleRevision: generation.lifecycleRevision,
        updatedAt: 1,
      });
      await enqueueDeliveryOnce(
        { ...payload, sessionGeneration: generation },
        queueId,
        originalRoot,
      );
      const duringSend = (input: object) => {
        expectPublicInput(input);
        ambient(otherState());
      };
      const sendText = installSender(duringSend);
      const custom = customDelivery((input) => {
        duringSend(input);
        expect(input).not.toHaveProperty("env");
      });
      const cwd =
        locator !== "default" ? vi.spyOn(process, "cwd").mockReturnValue(originalDirectory) : null;
      const stateDir = {
        default: undefined,
        relative: "queue",
        "home-relative": "  ~/queue  ",
      }[locator];
      await resumeDrain(
        {
          drainKey: `sdk-entry-${locator}-${callback}`,
          ...(stateDir !== undefined ? { stateDir } : {}),
          ...(callback === "custom" ? { deliver: custom } : {}),
        },
        () => {
          expect(custom).not.toHaveBeenCalled();
          expect(sendText).not.toHaveBeenCalled();
          ambient(replacementDirectory);
          vi.stubEnv("OPENCLAW_HOME", replacementDirectory);
          cwd?.mockReturnValue(replacementDirectory);
        },
      );
      expect([custom.mock.calls.length, sendText.mock.calls.length]).toEqual(
        callback === "custom" ? [1, 0] : [0, 1],
      );
      expect(await loadPendingDelivery(queueId, originalRoot, context)).toBeNull();
      await expectMissing(otherState());
    },
  );

  it("does not gain external ownership while an SDK reconnect waits for admission", async () => {
    const originalRoot = fixtures.tmpDir();
    const context = claimRoot(originalRoot);
    await enqueue(originalRoot);
    const sendText = installSender();
    vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
    const custom = customDelivery();
    await expect(
      resumeDrain({ deliver: custom }, () => vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "external")),
    ).rejects.toBeInstanceOf(OpenClawStateExternalOwnershipError);
    expect(custom).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(await loadPendingDelivery(queueId, originalRoot, context)).not.toBeNull();
  });

  it("keeps preparation, retry evidence, and ACK on the captured state after ambient changes", async () => {
    const context = claimRoot(fixtures.tmpDir());
    await withAmbientState(async () => {
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
      const external = claimRoot(fixtures.tmpDir());
      const id = await enqueueDelivery(payload, undefined, undefined, external);
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

  it("retains captured state through late cleanup of an unsent media owner", async () => {
    const context = claimRoot(fixtures.tmpDir());
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
    expect(await fs.promises.readFile(artifact, "utf8")).toBe("synthetic audio");
    await withAmbientState(async () => {
      await release?.();
      expect(await loadPendingDelivery(id, undefined, context)).toBeNull();
      expect((await readMedia({ expireBeforeMs: 0 }, context)).stagedArtifacts).toEqual([]);
      await expectMissing(artifact);
    });
  });
});
