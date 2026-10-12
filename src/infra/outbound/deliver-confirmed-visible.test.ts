import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type * as ConfirmedVisibleMessage from "../../sessions/background-session-result.js";
import type { commitConfirmedVisibleMessage } from "../../sessions/background-session-result.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { deliverOutboundPayloadsCore } from "./deliver-core.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

const mocks = vi.hoisted(() => ({
  commit: vi.fn<typeof commitConfirmedVisibleMessage>(async () => ({ ok: true })),
}));

vi.mock("../../sessions/background-session-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfirmedVisibleMessage>()),
  commitConfirmedVisibleMessage: mocks.commit,
}));

describe("confirmed outbound logical payloads", () => {
  beforeEach(() => mocks.commit.mockClear());
  afterEach(() => setActivePluginRegistry(createTestRegistry([])));

  it.each([true, false])(
    "commits a logical payload only when every physical part has an identity (%s)",
    async (confirmed) => {
      const plugin = createOutboundTestPlugin({
        id: "matrix",
        outbound: {
          deliveryMode: "direct",
          sendText: async () => ({ channel: "matrix", messageId: "unused" }),
          sendFormattedText: async () => [
            {
              channel: "matrix",
              messageId: "part-1",
              receipt: createMessageReceiptFromOutboundResults({
                results: [{ channel: "matrix", messageId: "part-1" }],
                threadId: "created-thread",
              }),
            },
            { channel: "matrix", messageId: confirmed ? "part-2" : "" },
          ],
          adoptTargetFromDelivery: ({ result }) =>
            result.receipt?.threadId ? { threadId: result.receipt.threadId } : null,
        },
      });
      setActivePluginRegistry(createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]));
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
        assertDirectAdapterHandoff: vi.fn(),
        assertTranscriptCurrent: vi.fn(),
        transcriptRoute: {
          sessionKey: "agent:main:matrix:group:destination",
          baseSessionKey: "agent:main:matrix:group:destination",
          peer: { kind: "group" as const, id: "destination" },
          chatType: "group" as const,
          from: "matrix:destination",
          to: "!destination:example",
        },
        transcriptExpectedGeneration: { sessionId: "prepared-session", lifecycleRevision: "old" },
      };
      await deliverOutboundPayloadsCore(params);
      if (confirmed) {
        expect(mocks.commit).toHaveBeenCalledOnce();
        expect(mocks.commit.mock.calls[0]?.[0]).toMatchObject({
          deliveryId: "durable-queue-id",
          payloadIndex: 3,
          producer: params.session,
          payload,
          to: "!destination:example",
          threadId: "created-thread",
          assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
          assertCurrent: params.assertTranscriptCurrent,
        });
        expect(mocks.commit.mock.calls[0]?.[0].route).toBeUndefined();
        expect(mocks.commit.mock.calls[0]?.[0].expectedGeneration).toBeUndefined();
      } else {
        expect(mocks.commit).not.toHaveBeenCalled();
      }
    },
  );
});
