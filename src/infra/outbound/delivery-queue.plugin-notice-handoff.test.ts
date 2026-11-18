import { expect, it, vi } from "vitest";
import type { ChannelMessageSendTextContext } from "../../channels/message/types.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { revokePluginRecord } from "../../plugins/registry-lifecycle.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createOutboundTestPlugin } from "../../test-utils/channel-plugins.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { deriveDeliveryQueueRetentionColumns } from "../delivery-queue-retention-columns.js";
import { resolveDeliveryQueueStateEnv } from "../delivery-queue-state-context.js";
import { matrixDeliveryResult, useOutboundFixture } from "./deliver.custody.test-support.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import { enqueueDelivery } from "./delivery-queue-storage.js";
import { createRecoveryLog, readQueueStatus } from "./delivery-queue.test-helpers.js";

const PLUGIN_ID = "notice-proof";
const outbound = useOutboundFixture();

/** Restart state: the posting plugin and the destination channel are loaded. */
function restart() {
  const sendText = vi.fn(async (_ctx: ChannelMessageSendTextContext) =>
    matrixDeliveryResult("recovered-notice"),
  );
  const { registry } = createTestPluginRegistry();
  const record = createPluginRecord({
    id: PLUGIN_ID,
    source: `/plugins/${PLUGIN_ID}/index.js`,
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  registry.plugins.push(record);
  const plugin = {
    ...createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
    message: {
      id: "matrix",
      durableFinal: { capabilities: { text: true } },
      send: { text: sendText },
    },
  };
  registry.channels = [{ pluginId: "matrix", source: "test", plugin }] as typeof registry.channels;
  setActivePluginRegistry(registry);
  return { sendText, revoke: () => revokePluginRecord(registry, record) };
}

async function recoverQueuedNotice(revokeDuringPreparation: boolean) {
  const id = await enqueueDelivery(
    {
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "Job finished." }],
      deliveryCompletion: { kind: "plugin-notice", pluginId: PLUGIN_ID },
    },
    outbound.tmpDir(),
  );
  const { sendText, revoke } = restart();
  const result = await recoverPendingDeliveries({
    // The real delivery path; the plugin is unloaded after recovery's initial owner check,
    // while recovery prepares the send and before the adapter handoff.
    deliver: async (params) => {
      if (revokeDuringPreparation) {
        revoke();
      }
      return await outbound.run(params);
    },
    log: createRecoveryLog(),
    cfg: {},
    stateDir: outbound.tmpDir(),
  });
  return { id, result, sendText };
}

it("sends a recovered plugin notice once through the adapter while its plugin stays loaded", async () => {
  const { id, result, sendText } = await recoverQueuedNotice(false);
  expect(result).toMatchObject({ recovered: 1, failed: 0 });
  expect(sendText).toHaveBeenCalledOnce();
  expect(readQueueStatus(outbound.tmpDir(), id)).toBeUndefined();
});

it("stops the recovered send at the adapter handoff when the plugin is unloaded during recovery", async () => {
  const { id, result, sendText } = await recoverQueuedNotice(true);
  expect(sendText).not.toHaveBeenCalled();
  expect(result).toMatchObject({ recovered: 0, failed: 1 });
  expect(readQueueStatus(outbound.tmpDir(), id)).not.toBe("pending");
});

/** Literal `entry_json` written by the v2026.10.9 queue writer (`createQueuedDelivery`). */
function storedV2026109Row(id: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    id,
    enqueuedAt: 1,
    channel: "matrix",
    to: "!room:example",
    preparedBatch: {
      schemaVersion: 1,
      sourcePayloadCount: 1,
      entries: [
        {
          sourceIndex: 0,
          status: "accepted",
          payload: { text: "stored before the plugin-notice kind" },
          replyHookChanged: false,
          messageHookChanged: false,
          preparedMediaCount: 0,
        },
      ],
    },
    ...extra,
    retryCount: 0,
    attemptCount: 0,
  });
}

it.each([
  ["a plain row", "stored-plain", {}],
  [
    "a retained producer row",
    "cron-direct-delivery:v1:stored",
    {
      completionRetention: {
        idPrefix: "cron-direct-delivery:v1:",
        maxAgeMs: 86_400_000,
        maxEntries: 2_000,
      },
      retainOnFailure: true,
    },
  ],
])("still loads and sends %s stored by v2026.10.9", async (_case, id, extra) => {
  const json = storedV2026109Row(id, extra);
  const db = requireNativeSqliteDatabase(
    openOpenClawStateDatabase({ env: resolveDeliveryQueueStateEnv(outbound.tmpDir()) }).db,
  );
  db.prepare(
    `INSERT INTO delivery_queue_entries
       (queue_name, id, status, entry_kind, session_key, channel, target, account_id,
        retry_count, last_attempt_at, last_error, platform_send_started_at, recovery_state,
        entry_json, enqueued_at, updated_at, failed_at,
        retention_id_prefix, retention_max_age_ms, retention_max_entries)
     VALUES (?, ?, 'pending', NULL, NULL, NULL, NULL, NULL,
             0, NULL, NULL, NULL, NULL, ?, 1, 1, NULL,
             @retention_id_prefix, @retention_max_age_ms, @retention_max_entries)`,
  ).run(deriveDeliveryQueueRetentionColumns(id, json), OUTBOUND_DELIVERY_QUEUE_NAME, id, json);
  const { sendText } = restart();

  const result = await recoverPendingDeliveries({
    deliver: async (params) => await outbound.run(params),
    log: createRecoveryLog(),
    cfg: {},
    stateDir: outbound.tmpDir(),
  });
  expect(result).toMatchObject({ recovered: 1, failed: 0 });
  expect(sendText).toHaveBeenCalledOnce();
  expect(sendText.mock.calls[0]?.[0]).toMatchObject({
    to: "!room:example",
    text: "stored before the plugin-notice kind",
  });
  expect(readQueueStatus(outbound.tmpDir(), id)).not.toBe("pending");
});
