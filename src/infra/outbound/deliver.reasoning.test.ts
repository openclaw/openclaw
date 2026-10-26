import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import {
  bindReplyReasoningVisibility,
  registerReplyReasoningVisibility,
} from "../../auto-reply/reply/reasoning-visibility-state.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { createChannelHandler } from "./deliver-channel.js";
import type { ChannelHandler } from "./deliver-contracts.js";
import { deliverOutboundPayloadsCore } from "./deliver-core.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

// mock-isolation: exercise core transport selection without plugin, SDK, or database owners.
vi.mock("./deliver-channel.js", () => ({ createChannelHandler: vi.fn() }));

const releases: Array<() => void> = [];
let handler: ChannelHandler;
beforeEach(() => {
  handler = {
    chunker: null,
    supportsMedia: false,
    supportsReasoningPayloads: true,
    buildTargetRef: () => ({ channel: "matrix", to: "!room:example.org" }),
    sendText: vi.fn(async () => ({ channel: "matrix", messageId: "$text" })),
    sendPayload: vi.fn(async () => ({ channel: "matrix", messageId: "$payload" })),
    sendMedia: vi.fn(async () => {
      throw new Error("Unexpected media transport");
    }),
  };
  vi.mocked(createChannelHandler).mockReset().mockResolvedValue(handler);
});
afterEach(() => {
  for (const release of releases.splice(0)) {
    release();
  }
});

function bind(payload: ReplyPayload) {
  const owner = { retainForQueue: () => {}, releaseDispatch: () => {}, close: () => {} };
  const release = registerReplyReasoningVisibility(owner, () => true);
  releases.push(release);
  bindReplyReasoningVisibility(payload, owner);
  return release;
}

function deliver(payload: ReplyPayload, guarded = true) {
  const onPayloadDeliveryOutcome = vi.fn();
  const result = deliverOutboundPayloadsCore({
    cfg: {},
    channel: "matrix",
    to: "!room:example.org",
    payloads: [payload],
    preparedBatch: createUnmodifiedPreparedOutboundBatch([payload]),
    ...(guarded ? { reasoningPayloadIndexes: new Set([0]) } : {}),
    onPayloadDeliveryOutcome,
  });
  return { result, onPayloadDeliveryOutcome };
}

describe("original guarded reasoning delivery lane", () => {
  it("keeps a host-bound payload intact for the opted-in adapter", async () => {
    const payload = { text: "private thought", isReasoning: true };
    bind(payload);
    await expect(deliver(payload).result).resolves.toMatchObject([{ messageId: "$payload" }]);
    expect(handler.sendPayload).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({ guardedReasoning: true }),
    );
    expect(handler.sendText).not.toHaveBeenCalled();
  });

  it.each(["metadata lost", "type lost", "expired", "forged", "target opt-out", "missing sender"])(
    "never downgrades an originally bound source after %s",
    async (change) => {
      const payload: ReplyPayload = { text: "private thought", isReasoning: true };
      const sendPayload = handler.sendPayload;
      if (change === "forged") {
        setReplyPayloadMetadata(payload, { reasoningVisibilityOwner: {} });
      } else if (change !== "metadata lost") {
        const release = bind(payload);
        if (change === "expired") {
          release();
        }
      }
      if (change === "type lost") {
        payload.isReasoning = false;
      }
      if (change === "target opt-out") {
        handler.supportsReasoningPayloads = false;
      }
      if (change === "missing sender") {
        handler.sendPayload = undefined;
      }
      // The source index was captured before a modifier produced this effective payload.
      const pending = deliver(payload);
      await expect(pending.result).resolves.toEqual([]);
      expect(pending.onPayloadDeliveryOutcome).toHaveBeenCalledWith({
        index: 0,
        status: "suppressed",
        reason: "adapter_returned_no_send",
      });
      expect(handler.sendText).not.toHaveBeenCalled();
      expect(sendPayload).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "preserves unbound cron transport with structured=%s",
    async (structured) => {
      const payload = {
        text: "legacy cron reasoning",
        isReasoning: true,
        ...(structured ? { channelData: { matrix: { legacy: true } } } : {}),
      };
      await deliver(payload, false).result;
      if (structured) {
        expect(handler.sendPayload).toHaveBeenCalledWith(
          payload,
          expect.not.objectContaining({ guardedReasoning: true }),
        );
        expect(handler.sendText).not.toHaveBeenCalled();
      } else {
        expect(handler.sendText).toHaveBeenCalled();
        expect(handler.sendPayload).not.toHaveBeenCalled();
      }
    },
  );
});
