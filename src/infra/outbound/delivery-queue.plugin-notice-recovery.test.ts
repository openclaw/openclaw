import { afterEach, expect, it, vi } from "vitest";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest } from "../../audit/message-audit-events.test-support.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { revokePluginRecord } from "../../plugins/registry-lifecycle.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import { enqueueDelivery } from "./delivery-queue-storage.js";
import {
  asDeliverFn,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  readQueueStatus,
} from "./delivery-queue.test-helpers.js";

const ownerLog = vi.hoisted(() => ({ warn: vi.fn() }));
// Observe only the completion owner's log; every other subsystem keeps its real logger.
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => {
      const logger = actual.createSubsystemLogger(name);
      return name === "outbound/delivery-completion"
        ? Object.assign(Object.create(logger), { warn: ownerLog.warn })
        : logger;
    },
  };
});

const PLUGIN_ID = "notice-proof";
const { tmpDir } = installDeliveryQueueTmpDirHooks();

afterEach(() => {
  ownerLog.warn.mockClear();
  resetPluginRuntimeStateForTest();
});

/** Restart state: the Gateway loads its configured plugins before recovery drains the queue. */
function restartWith(plugin: "loaded" | "disabled" | "revoked") {
  const { registry } = createTestPluginRegistry();
  const record = createPluginRecord({
    id: PLUGIN_ID,
    source: `/plugins/${PLUGIN_ID}/index.js`,
    origin: "global",
    enabled: plugin !== "disabled",
    configSchema: false,
  });
  registry.plugins.push(record);
  setActivePluginRegistry(registry);
  if (plugin === "revoked") {
    revokePluginRecord(registry, record);
  }
}

/** The row a crashed process left behind after admitting a plugin notice, before sending it. */
function queueCrashedNotice() {
  return enqueueDelivery(
    {
      channel: "demo-channel-a",
      to: "user-1",
      payloads: [{ text: "Job finished." }],
      deliveryCompletion: { kind: "plugin-notice", pluginId: PLUGIN_ID },
    },
    tmpDir(),
  );
}

async function recover() {
  const deliver = vi.fn(async () => [{ channel: "demo-channel-a", messageId: "m1" }]);
  const log = createRecoveryLog();
  const audits: TrustedMessageAuditEvent[] = [];
  const unsubscribe = onTrustedMessageAuditEventForTest((event) => audits.push(event));
  try {
    const result = await recoverPendingDeliveries({
      deliver: asDeliverFn(deliver),
      log,
      cfg: {},
      stateDir: tmpDir(),
    });
    return { deliver, audits, result };
  } finally {
    unsubscribe();
  }
}

it("replays a queued plugin notice once while its plugin is loaded", async () => {
  const id = await queueCrashedNotice();
  restartWith("loaded");

  const { deliver, result } = await recover();
  expect(result).toMatchObject({ recovered: 1, failed: 0 });
  expect(deliver).toHaveBeenCalledOnce();
  expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ to: "user-1" }));
  expect(ownerLog.warn).not.toHaveBeenCalled();
  expect(readQueueStatus(tmpDir(), id)).toBeUndefined();
});

it.each(["disabled", "revoked"] as const)(
  "refuses a queued plugin notice before any send when its plugin is %s",
  async (state) => {
    const id = await queueCrashedNotice();
    restartWith(state);

    const { deliver, audits, result } = await recover();
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    // The owner refusal is the only terminal record: a failed send audit with no result.
    expect(audits).toMatchObject([
      { action: "message.outbound.finished", outcome: "failed", resultCount: 0 },
    ]);
    expect(ownerLog.warn).toHaveBeenCalledWith(
      `Refusing a queued plugin notice: plugin "${PLUGIN_ID}" that posted this notice is no longer active`,
    );
    // The refused intent leaves the pending queue, so no later pass sends it.
    expect(readQueueStatus(tmpDir(), id)).not.toBe("pending");
    const again = await recover();
    expect(again.deliver).not.toHaveBeenCalled();
  },
);
