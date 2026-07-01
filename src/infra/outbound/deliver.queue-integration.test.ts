import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { drainPendingDeliveries, type DeliverFn, loadPendingDeliveries } from "./delivery-queue.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

type MatrixSendFn = (
  to: string,
  text: string,
  options?: Record<string, unknown>,
) => Promise<{ messageId: string } & Record<string, unknown>>;

function resolveMatrixSender(
  deps: Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0]["deps"],
): MatrixSendFn {
  const sender = deps?.matrix;
  if (typeof sender !== "function") {
    throw new Error("missing matrix sender");
  }
  return sender as MatrixSendFn;
}

function withMatrixChannel(result: Awaited<ReturnType<MatrixSendFn>>) {
  return {
    channel: "matrix" as const,
    ...result,
  };
}

const matrixOutboundForQueueTest: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ cfg, to, text, accountId, deps }) =>
    withMatrixChannel(
      await resolveMatrixSender(deps)(to, text, {
        cfg,
        accountId: accountId ?? undefined,
      }),
    ),
};

async function drainMatrixReconnect(opts: { deliver: DeliverFn; stateDir: string }): Promise<void> {
  await drainPendingDeliveries({
    drainKey: "matrix:reconnect-test",
    logLabel: "Matrix reconnect drain",
    cfg: {} as OpenClawConfig,
    log: createRecoveryLog(),
    stateDir: opts.stateDir,
    deliver: opts.deliver,
    selectEntry: (entry) => ({ match: entry.channel === "matrix" }),
  });
}

function createPartialSendFailure() {
  return vi
    .fn()
    .mockResolvedValueOnce({ messageId: "m1" })
    .mockRejectedValueOnce(new Error("second payload send failed"));
}

async function deliverPartialMatrixBatch(sendMatrix: ReturnType<typeof vi.fn>, tmpDir: string) {
  process.env.OPENCLAW_STATE_DIR = tmpDir;
  await expect(
    deliverOutboundPayloads({
      cfg: {} as OpenClawConfig,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "first" }, { text: "second" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required",
    }),
  ).rejects.toThrow("second payload send failed");
}

describe("deliverOutboundPayloads queue integration: mid-batch failure with send evidence", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let tmpDir: string;

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
        },
      ]),
    );
  });

  afterEach(() => {
    releasePinnedPluginChannelRegistry();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("advances queued entry to unknown_after_send when a later payload fails after an earlier one succeeded", async () => {
    const sendMatrix = createPartialSendFailure();

    await deliverPartialMatrixBatch(sendMatrix, tmpDir);

    const entries = await loadPendingDeliveries(tmpDir);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.recoveryState).toBe("unknown_after_send");
    expect(entry.retryCount).toBe(0);
    expect(entry.lastError).toBeUndefined();
    expect(sendMatrix).toHaveBeenCalledTimes(2);
  });

  it("drain does not replay an unknown_after_send entry when no adapter reconciliation is available", async () => {
    const sendMatrix = createPartialSendFailure();

    await deliverPartialMatrixBatch(sendMatrix, tmpDir);

    const beforeDrain = await loadPendingDeliveries(tmpDir);
    expect(beforeDrain[0]?.recoveryState).toBe("unknown_after_send");

    const deliver = vi.fn<DeliverFn>(async () => {});
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    expect(deliver).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
  });

  it("leaves entry for retry in send_attempt_started when no send evidence exists", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi.fn().mockRejectedValueOnce(new Error("first payload send failed"));

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("first payload send failed");

    const entries = await import("./delivery-queue.js").then((m) =>
      m.loadPendingDeliveries(tmpDir),
    );
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.retryCount).toBe(1);
    expect(entry.recoveryState).toBe("send_attempt_started");
    expect(entry.lastError).toContain("first payload send failed");
  });
});
