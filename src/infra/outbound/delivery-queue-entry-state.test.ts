import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendDurableMessageBatch } from "../../plugin-sdk/channel-outbound.js";
import { drainPendingDeliveries } from "../../plugin-sdk/delivery-queue-runtime.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { claimOpenClawStateOwnership } from "../../state/openclaw-state-ownership-operations.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { captureDeliveryQueueStateContext } from "../delivery-queue-sqlite.js";
import { OpenClawStateExternalOwnershipError } from "../sqlite-lifecycle-errors.js";
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

  function root(name: string) {
    const dir = path.join(fixtures.tmpDir(), name);
    fs.mkdirSync(dir);
    return dir;
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

  const inputFor = (text: string) => ({
    cfg: {},
    channel: "reef" as const,
    to: target,
    payloads: [{ text }],
    queuePolicy: "required" as const,
    requireUnknownSendReconciliation: false,
  });
  function claimRoot(stateDir: string) {
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "external");
    claimOpenClawStateOwnership("queue-fixture", { env: process.env });
    return captureDeliveryQueueStateContext(stateDir);
  }
  const enqueue = (id: string, stateDir: string, text: string, queuePolicy?: "required") =>
    enqueueDeliveryOnce(
      { channel: "reef", to: target, payloads: [{ text }], queuePolicy },
      id,
      stateDir,
    );
  function suspend() {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    return suspension;
  }
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
      const sendText = installSender((input) => {
        expect(input).not.toHaveProperty("conversationDeliveryTarget");
        expect(input).not.toHaveProperty("deliveryQueueStateContext");
        expect(readQueuedEntries(originalRoot)).toHaveLength(1);
        expect(readQueuedEntries(injectedRoot)).toEqual([]);
      });
      const input = {
        ...inputFor("public contract"),
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
        await expect(sendDurableMessageBatch(input)).resolves.toMatchObject({ status: "sent" });
      } else {
        await expect(deliverOutboundPayloads(input)).resolves.toMatchObject([
          { messageId: "sent" },
        ]);
      }
      expect(sendText).toHaveBeenCalledOnce();
    },
  );

  it("retains the default root and supervisor mode through awaited preparation", async () => {
    const originalRoot = root("original");
    const replacementRoot = root("replacement");

    const context = claimRoot(originalRoot);
    const queueId = "default-root-capture";
    const sendText = installSender(async () => {
      expect(await loadPendingDelivery(queueId, originalRoot, context)).not.toBeNull();
      expect(await loadPendingDelivery(queueId, replacementRoot)).toBeNull();
    });
    const delivery = deliverOutboundPayloads({
      ...inputFor("default owner"),
      deliveryIntentId: queueId,
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", replacementRoot);
    vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
    await expect(delivery).resolves.toMatchObject([{ messageId: "sent" }]);
    expect(await loadPendingDelivery(queueId, originalRoot, context)).toBeNull();
    expect(await loadPendingDelivery(queueId, replacementRoot)).toBeNull();
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("honors the owned root when resuming an existing queue entry", async () => {
    const originalRoot = root("recovery");
    const ambientRoot = root("ambient");

    vi.stubEnv("OPENCLAW_STATE_DIR", ambientRoot);
    const queueId = "existing-recovery-entry";
    await enqueue(queueId, originalRoot, "recovered", "required");
    const sendText = installSender(async () => {
      expect(await loadPendingDelivery(queueId, originalRoot)).toMatchObject({
        recoveryState: "send_attempt_started",
      });
    });
    await expect(
      deliverOutboundPayloads({
        ...inputFor("recovered"),
        skipQueue: true,
        deliveryQueueId: queueId,
        deliveryQueueStateDir: originalRoot,
      }),
    ).resolves.toMatchObject([{ messageId: "sent" }]);
    expect(sendText).toHaveBeenCalledOnce();
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
      resetGatewayWorkAdmission();
      const originalDirectory = root("original");
      const originalRoot = path.join(originalDirectory, "queue");
      const replacementDirectory = root("replacement");
      fs.mkdirSync(originalRoot, { recursive: true });

      vi.stubEnv("OPENCLAW_HOME", originalDirectory);
      const context = claimRoot(originalRoot);
      const queueId = "sdk-reconnect-owner";
      await enqueue(queueId, originalRoot, "SDK reconnect");
      const sendText = installSender((input) => {
        expect(input).not.toHaveProperty("deliveryQueueStateContext");
      });
      const custom = customDelivery((input) => {
        expect(input).not.toHaveProperty("deliveryQueueStateContext");
        expect(input).not.toHaveProperty("env");
      });
      const cwd =
        locator !== "default" ? vi.spyOn(process, "cwd").mockReturnValue(originalDirectory) : null;
      const stateDir = {
        default: undefined,
        relative: "queue",
        "home-relative": "  ~/queue  ",
      }[locator];
      const suspension = suspend();
      const pending = drain({
        drainKey: `sdk-entry-${locator}-${callback}`,
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
        expect([custom.mock.calls.length, sendText.mock.calls.length]).toEqual(
          callback === "custom" ? [1, 0] : [0, 1],
        );
        if (callback === "custom") {
          expect(custom.mock.calls[0]).toHaveLength(1);
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
    const context = claimRoot(originalRoot);
    const queueId = "sdk-unprivileged-owner";
    await enqueue(queueId, originalRoot, "retained");
    const sendText = installSender();
    vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
    const suspension = suspend();
    const custom = customDelivery();
    const pending = drain({ deliver: custom });
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
