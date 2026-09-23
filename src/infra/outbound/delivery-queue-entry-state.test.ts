import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { sendDurableMessageBatch } from "../../plugin-sdk/channel-outbound.js";
import { drainPendingDeliveries } from "../../plugin-sdk/delivery-queue-runtime.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { OpenClawStateExternalOwnershipError } from "../../state/openclaw-state-ownership-error.js";
import { claimOpenClawStateOwnership } from "../../state/openclaw-state-ownership-operations.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { captureDeliveryQueueStateContext } from "../delivery-queue-sqlite.js";
import { deliverOutboundPayloads } from "./deliver.js";
import { ackDelivery } from "./delivery-queue-ack.js";
import type { DeliverFn } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce, loadPendingDelivery } from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  readQueuedEntries,
} from "./delivery-queue.test-helpers.js";

describe("delivery queue entry state", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  const target = "reef:synthetic-peer";

  function installSender(sendText: NonNullable<ChannelOutboundAdapter["sendText"]>) {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "reef",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "reef",
            outbound: { deliveryMode: "direct", sendText },
          }),
        },
      ]),
    );
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
      const originalRoot = path.join(fixtures.tmpDir(), "original");
      const injectedRoot = path.join(fixtures.tmpDir(), "injected");
      fs.mkdirSync(originalRoot);
      fs.mkdirSync(injectedRoot);
      vi.stubEnv("OPENCLAW_STATE_DIR", originalRoot);
      const sendText = vi.fn(async (input: object) => {
        expect(input).not.toHaveProperty("conversationDeliveryTarget");
        expect(input).not.toHaveProperty("deliveryQueueStateContext");
        expect(readQueuedEntries(originalRoot)).toHaveLength(1);
        expect(readQueuedEntries(injectedRoot)).toEqual([]);
        return { channel: "reef" as const, messageId: "public-send" };
      });
      installSender(sendText);
      const input = {
        cfg: {},
        channel: "reef" as const,
        to: target,
        payloads: [{ text: "public contract" }],
        queuePolicy: "required" as const,
        durability: "required" as const,
        requireUnknownSendReconciliation: false,
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
        await expect(sendDurableMessageBatch(input)).resolves.toMatchObject({ status: "sent" });
      } else {
        await expect(deliverOutboundPayloads(input)).resolves.toMatchObject([
          { messageId: "public-send" },
        ]);
      }
      expect(sendText).toHaveBeenCalledOnce();
    },
  );

  it("retains the default root and supervisor mode through awaited preparation", async () => {
    const originalRoot = path.join(fixtures.tmpDir(), "original");
    const replacementRoot = path.join(fixtures.tmpDir(), "replacement");
    fs.mkdirSync(originalRoot);
    fs.mkdirSync(replacementRoot);
    vi.stubEnv("OPENCLAW_STATE_DIR", originalRoot);
    vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "external");
    claimOpenClawStateOwnership("queue-fixture", { env: process.env });
    const context = captureDeliveryQueueStateContext(originalRoot);
    const queueId = "default-root-capture";
    const sendText = vi.fn(async () => {
      expect(await loadPendingDelivery(queueId, originalRoot, context)).not.toBeNull();
      expect(await loadPendingDelivery(queueId, replacementRoot)).toBeNull();
      return { channel: "reef" as const, messageId: "captured-default" };
    });
    installSender(sendText);
    const delivery = deliverOutboundPayloads({
      cfg: {},
      channel: "reef",
      to: target,
      payloads: [{ text: "default owner" }],
      queuePolicy: "required",
      deliveryIntentId: queueId,
      requireUnknownSendReconciliation: false,
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", replacementRoot);
    vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
    await expect(delivery).resolves.toMatchObject([{ messageId: "captured-default" }]);
    expect(await loadPendingDelivery(queueId, originalRoot, context)).toBeNull();
    expect(await loadPendingDelivery(queueId, replacementRoot)).toBeNull();
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("honors the owned root when resuming an existing queue entry", async () => {
    const originalRoot = path.join(fixtures.tmpDir(), "recovery");
    const ambientRoot = path.join(fixtures.tmpDir(), "ambient");
    fs.mkdirSync(originalRoot);
    fs.mkdirSync(ambientRoot);
    vi.stubEnv("OPENCLAW_STATE_DIR", ambientRoot);
    const queueId = "existing-recovery-entry";
    await enqueueDeliveryOnce(
      { channel: "reef", to: target, payloads: [{ text: "recovered" }], queuePolicy: "required" },
      queueId,
      originalRoot,
    );
    const sendText = vi.fn(async () => {
      expect(await loadPendingDelivery(queueId, originalRoot)).toMatchObject({
        recoveryState: "send_attempt_started",
      });
      return { channel: "reef" as const, messageId: "recovered-root" };
    });
    installSender(sendText);
    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "reef",
        to: target,
        payloads: [{ text: "recovered" }],
        queuePolicy: "required",
        skipQueue: true,
        deliveryQueueId: queueId,
        deliveryQueueStateDir: originalRoot,
        requireUnknownSendReconciliation: false,
      }),
    ).resolves.toMatchObject([{ messageId: "recovered-root" }]);
    expect(sendText).toHaveBeenCalledOnce();
    expect(await loadPendingDelivery(queueId, ambientRoot)).toBeNull();
    await ackDelivery(queueId, originalRoot);
  });

  it.each([
    ["default", "custom"],
    ["default", "builtin"],
    ["relative", "custom"],
    ["relative", "builtin"],
    ["home-relative", "custom"],
    ["home-relative", "builtin"],
    ["empty", "custom"],
    ["empty", "builtin"],
  ] as const)(
    "captures the SDK %s root before admission and lazy delivery for a %s callback",
    async (locator, callback) => {
      resetGatewayWorkAdmission();
      const originalDirectory = path.join(fixtures.tmpDir(), "original");
      const originalRoot = path.join(originalDirectory, "queue");
      const replacementDirectory = path.join(fixtures.tmpDir(), "replacement");
      fs.mkdirSync(originalRoot, { recursive: true });
      fs.mkdirSync(replacementDirectory);
      vi.stubEnv("OPENCLAW_STATE_DIR", originalRoot);
      vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "external");
      vi.stubEnv("OPENCLAW_HOME", originalDirectory);
      claimOpenClawStateOwnership("queue-fixture", { env: process.env });
      const context = captureDeliveryQueueStateContext(originalRoot);
      const queueId = "sdk-reconnect-owner";
      await enqueueDeliveryOnce(
        { channel: "reef", to: target, payloads: [{ text: "SDK reconnect" }] },
        queueId,
        originalRoot,
      );
      const sendText = vi.fn(async (input: object) => {
        expect(input).not.toHaveProperty("deliveryQueueStateContext");
        return { channel: "reef" as const, messageId: "sdk-builtin" };
      });
      installSender(sendText);
      const custom = vi.fn<DeliverFn>(async (input) => {
        expect(input).not.toHaveProperty("deliveryQueueStateContext");
        expect(input).not.toHaveProperty("env");
        await input.onPlatformSendStart?.({});
        return [{ channel: "reef", messageId: "sdk-custom" }];
      });
      const cwd =
        locator !== "default" ? vi.spyOn(process, "cwd").mockReturnValue(originalDirectory) : null;
      const stateDir = {
        default: undefined,
        relative: "queue",
        "home-relative": "  ~/queue  ",
        empty: "",
      }[locator];
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.commit()).toBe(true);
      const pending = drainPendingDeliveries({
        drainKey: `sdk-entry-${locator}-${callback}`,
        logLabel: "Synthetic SDK reconnect",
        cfg: {},
        log: createRecoveryLog(),
        selectEntry: () => ({ match: true, bypassBackoff: false }),
        ...(stateDir !== undefined ? { stateDir } : {}),
        ...(callback === "custom" ? { deliver: custom } : {}),
      });
      try {
        await setImmediate();
        expect(custom).not.toHaveBeenCalled();
        expect(sendText).not.toHaveBeenCalled();
        vi.stubEnv("OPENCLAW_STATE_DIR", replacementDirectory);
        vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
        vi.stubEnv("OPENCLAW_HOME", replacementDirectory);
        cwd?.mockReturnValue(replacementDirectory);
        expect(suspension?.release()).toBe(true);
        await pending;
        if (callback === "custom") {
          expect(custom).toHaveBeenCalledOnce();
          expect(custom.mock.calls[0]).toHaveLength(1);
          expect(sendText).not.toHaveBeenCalled();
        } else {
          expect(sendText).toHaveBeenCalledOnce();
          expect(custom).not.toHaveBeenCalled();
        }
        expect(await loadPendingDelivery(queueId, originalRoot, context)).toBeNull();
      } finally {
        suspension?.release();
        await pending;
        cwd?.mockRestore();
      }
    },
  );

  it("does not gain external ownership while an SDK reconnect waits for admission", async () => {
    resetGatewayWorkAdmission();
    const originalRoot = fixtures.tmpDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", originalRoot);
    vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "external");
    claimOpenClawStateOwnership("queue-fixture", { env: process.env });
    const context = captureDeliveryQueueStateContext(originalRoot);
    const queueId = "sdk-unprivileged-owner";
    await enqueueDeliveryOnce(
      { channel: "reef", to: target, payloads: [{ text: "retained" }] },
      queueId,
      originalRoot,
    );
    const sendText = vi.fn(async () => ({
      channel: "reef" as const,
      messageId: "unexpected-send",
    }));
    installSender(sendText);
    vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const custom = vi.fn<DeliverFn>(async (input) => {
      await input.onPlatformSendStart?.({});
      return [{ channel: "reef", messageId: "unexpected-dispatch" }];
    });
    const pending = drainPendingDeliveries({
      drainKey: "sdk-unprivileged",
      logLabel: "Synthetic SDK reconnect",
      cfg: {},
      log: createRecoveryLog(),
      deliver: custom,
      selectEntry: () => ({ match: true, bypassBackoff: false }),
    });
    const outcome = pending.catch((error: unknown) => error);
    try {
      await setImmediate();
      vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "external");
      expect(suspension?.release()).toBe(true);
      await expect(outcome).resolves.toBeInstanceOf(OpenClawStateExternalOwnershipError);
      expect(custom).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
      expect(await loadPendingDelivery(queueId, originalRoot, context)).not.toBeNull();
    } finally {
      suspension?.release();
      await outcome;
    }
  });
});
