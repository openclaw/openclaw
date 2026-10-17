// Typed callback ownership is a durable fact of a send: the agent-owned origin
// of a `message` tool call must reach the channel's presentation renderer on the
// live path and again when durable recovery replays the row after a restart.
import { describe, expect, it } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelOutboundContext } from "../../channels/plugins/outbound.types.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { deliverOutboundPayloadsCore } from "./deliver-core.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { decodeOutboundDeliverySnapshot } from "./delivery-queue-projection.js";
import { buildRecoveryDeliverParams } from "./delivery-queue-recovery-params.js";
import { enqueueDelivery, loadPendingDelivery } from "./delivery-queue-storage.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";
import { installDeliveryQueueTmpDirHooks, readQueuedEntry } from "./delivery-queue.test-helpers.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

const CHANNEL = "owner-probe";
const PAYLOADS = [
  {
    text: "Deploy?",
    presentation: {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            { label: "Deploy", action: { type: "callback" as const, value: "deploy prod" } },
          ],
        },
      ],
    },
  },
];
// Row shape written by releases that did not know `actionOrigin`; the field is
// simply absent, so older rows must keep rendering as plugin-owned controls.
const LEGACY_ENTRY_JSON = JSON.stringify({
  id: "legacy-row",
  enqueuedAt: 1,
  retryCount: 0,
  attemptCount: 0,
  channel: CHANNEL,
  to: "user-1",
  queuePolicy: "best_effort",
  preparedBatch: createUnmodifiedPreparedOutboundBatch(PAYLOADS),
});

function createOwnerProbePlugin() {
  const renderedOrigins: Array<string | undefined> = [];
  const sentTexts: string[] = [];
  const outbound: ChannelOutboundAdapter = {
    deliveryMode: "direct",
    presentationCapabilities: { supported: true, buttons: true },
    // Mirrors Telegram: ownership is decided where the buttons are materialized.
    renderPresentation: ({ payload, ctx }) => {
      renderedOrigins.push(ctx.actionOrigin);
      const owner = ctx.actionOrigin === "message-tool" ? "agent" : "plugin";
      return { ...payload, text: `${owner}-owned:${payload.text ?? ""}` };
    },
    sendText: async (ctx: ChannelOutboundContext) => {
      sentTexts.push(ctx.text);
      const messageId = `sent-${sentTexts.length}`;
      return {
        channel: CHANNEL,
        messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: CHANNEL, messageId }],
          kind: "text",
        }),
      };
    },
  };
  const plugin: ChannelPlugin = { ...createChannelTestPluginBase({ id: CHANNEL }), outbound };
  return { plugin, renderedOrigins, sentTexts };
}

async function deliverRecovered(entry: QueuedDelivery, stateDir: string) {
  const probe = createOwnerProbePlugin();
  const registry = createTestRegistry([
    { pluginId: CHANNEL, plugin: probe.plugin, source: "test" },
  ]);
  // Recovery rebuilds delivery from the stored row alone, exactly as after a restart.
  const { release, ...params } = await buildRecoveryDeliverParams(entry, {}, stateDir);
  try {
    await withPluginRuntimeRegistryScope(registry, () => deliverOutboundPayloadsCore(params));
  } finally {
    release();
  }
  return probe;
}

describe("typed callback ownership across durable recovery", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();

  it.each([
    {
      label: "agent-owned message-tool sends",
      actionOrigin: "message-tool" as const,
      owner: "agent",
    },
    { label: "plugin and operator sends", actionOrigin: undefined, owner: "plugin" },
  ])("renders $label the same way live and after replay", async ({ actionOrigin, owner }) => {
    const stateDir = tmpDir();
    const probe = createOwnerProbePlugin();
    const registry = createTestRegistry([
      { pluginId: CHANNEL, plugin: probe.plugin, source: "test" },
    ]);
    const params = {
      cfg: {},
      channel: CHANNEL,
      to: "user-1",
      payloads: PAYLOADS,
      ...(actionOrigin ? { actionOrigin } : {}),
    };
    await withPluginRuntimeRegistryScope(registry, () =>
      deliverOutboundPayloadsCore({
        ...params,
        preparedBatch: createUnmodifiedPreparedOutboundBatch(PAYLOADS),
      }),
    );
    expect(probe.renderedOrigins).toEqual([actionOrigin]);
    expect(probe.sentTexts).toEqual([`${owner}-owned:Deploy?`]);

    const id = await enqueueDelivery(params, stateDir);
    const stored = readQueuedEntry(stateDir, id);
    if (actionOrigin) {
      expect(stored.actionOrigin).toBe(actionOrigin);
    } else {
      expect(stored).not.toHaveProperty("actionOrigin");
    }
    const entry = await loadPendingDelivery(id, stateDir);
    if (!entry) {
      throw new Error("Expected pending delivery");
    }
    const recovered = await deliverRecovered(entry, stateDir);
    expect(recovered.renderedOrigins).toEqual([actionOrigin]);
    expect(recovered.sentTexts).toEqual([`${owner}-owned:Deploy?`]);
  });

  it("loads rows stored before ownership existed and keeps them plugin-owned", async () => {
    expect(LEGACY_ENTRY_JSON).not.toContain("actionOrigin");
    const entry = decodeOutboundDeliverySnapshot({
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      entryJson: LEGACY_ENTRY_JSON,
    });
    const recovered = await deliverRecovered(entry, tmpDir());
    expect(recovered.renderedOrigins).toEqual([undefined]);
    expect(recovered.sentTexts).toEqual(["plugin-owned:Deploy?"]);
  });
});
