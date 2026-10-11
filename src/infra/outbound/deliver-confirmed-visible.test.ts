import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type * as ConfirmedVisibleMessage from "../../sessions/confirmed-visible-message.js";
import type { commitConfirmedVisibleMessage } from "../../sessions/confirmed-visible-message.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { deliverOutboundPayloadsCore } from "./deliver-core.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

const mocks = vi.hoisted(() => ({
  commit: vi.fn<typeof commitConfirmedVisibleMessage>(async () => ({ ok: true })),
}));

vi.mock("../../sessions/confirmed-visible-message.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfirmedVisibleMessage>()),
  commitConfirmedVisibleMessage: mocks.commit,
}));

function setTestOutbound(overrides: Partial<ChannelOutboundAdapter>) {
  const plugin = createOutboundTestPlugin({
    id: "matrix",
    outbound: {
      deliveryMode: "direct",
      sendText: async () => ({ channel: "matrix", messageId: "unused" }),
      ...overrides,
    },
  });
  setActivePluginRegistry(createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]));
}

describe("confirmed outbound logical payloads", () => {
  beforeEach(() => mocks.commit.mockClear());
  afterEach(() => setActivePluginRegistry(createTestRegistry([])));

  it("commits one logical payload with its durable identity and original source index", async () => {
    setTestOutbound({
      sendFormattedText: async () => [
        { channel: "matrix", messageId: "part-1" },
        { channel: "matrix", messageId: "part-2" },
      ],
    });
    const payload = { text: "one logical message" };
    const preparedBatch = createUnmodifiedPreparedOutboundBatch([payload]);
    preparedBatch.entries[0]!.sourceIndex = 3;
    const params = {
      cfg: {},
      channel: "matrix",
      to: "!destination:example",
      payloads: [payload],
      preparedBatch,
      deliveryQueueId: "durable-queue-id",
      session: { key: "agent:main:source", agentId: "main" },
    };
    await deliverOutboundPayloadsCore(params);
    await deliverOutboundPayloadsCore(params);
    expect(mocks.commit).toHaveBeenCalledTimes(2);
    for (const [commit] of mocks.commit.mock.calls) {
      expect(commit).toMatchObject({
        deliveryId: "durable-queue-id",
        payloadIndex: 3,
        producer: params.session,
        payload,
      });
    }
  });

  it("publishes an adapter-created thread without reusing the prepared route or generation", async () => {
    setTestOutbound({
      sendText: async () => ({
        channel: "matrix",
        messageId: "thread-message",
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "matrix", messageId: "thread-message" }],
          threadId: "created-thread",
        }),
      }),
      adoptTargetFromDelivery: ({ result }) =>
        result.receipt?.threadId ? { threadId: result.receipt.threadId } : null,
    });
    const payloads = [{ text: "thread reply" }];
    await deliverOutboundPayloadsCore({
      cfg: {},
      channel: "matrix",
      to: "!destination:example",
      payloads,
      preparedBatch: createUnmodifiedPreparedOutboundBatch(payloads),
      transcriptRoute: {
        sessionKey: "agent:main:matrix:group:destination",
        baseSessionKey: "agent:main:matrix:group:destination",
        peer: { kind: "group", id: "destination" },
        chatType: "group",
        from: "matrix:destination",
        to: "!destination:example",
      },
      transcriptExpectedGeneration: { sessionId: "prepared-session", lifecycleRevision: "old" },
    });
    expect(mocks.commit).toHaveBeenCalledOnce();
    expect(mocks.commit.mock.calls[0]?.[0]).toMatchObject({
      to: "!destination:example",
      threadId: "created-thread",
      payload: { text: "thread reply" },
    });
    expect(mocks.commit.mock.calls[0]?.[0].route).toBeUndefined();
    expect(mocks.commit.mock.calls[0]?.[0].expectedGeneration).toBeUndefined();
  });

  it("does not commit a logical payload containing an identityless physical part", async () => {
    setTestOutbound({
      sendFormattedText: async () => [
        { channel: "matrix", messageId: "part-1" },
        { channel: "matrix", messageId: "" },
      ],
    });
    const payloads = [{ text: "partly uncertain" }];
    await deliverOutboundPayloadsCore({
      cfg: {},
      channel: "matrix",
      to: "!destination:example",
      payloads,
      preparedBatch: createUnmodifiedPreparedOutboundBatch(payloads),
    });
    expect(mocks.commit).not.toHaveBeenCalled();
  });
});
