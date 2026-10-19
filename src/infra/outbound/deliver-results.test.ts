import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import { createChannelHandler } from "./deliver-channel.js";
import type {
  ChannelHandler,
  ChannelHandlerParams,
  DeliverOutboundPayloadsCoreParams,
} from "./deliver-contracts.js";
import { deliverOutboundPayloadsCore } from "./deliver-core.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import type { DeliveryPlacementEvidence } from "./delivery-placement-evidence.types.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

vi.mock("./deliver-channel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./deliver-channel.js")>()),
  createChannelHandler: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(createChannelHandler).mockReset();
});

function installHandler(
  send: (params: ChannelHandlerParams) => Pick<ChannelHandler, "sendText" | "sendFormattedText">,
): void {
  vi.mocked(createChannelHandler).mockImplementation(async (params) => ({
    chunker: null,
    supportsMedia: false,
    buildTargetRef: () => ({ channel: params.channel, to: params.to }),
    sendMedia: async () => {
      throw new Error("Unexpected media send");
    },
    ...send(params),
  }));
}

function deliver(
  params: Partial<
    Pick<
      DeliverOutboundPayloadsCoreParams,
      "channel" | "payloads" | "onDeliveryResult" | "onPayloadDeliveryOutcome"
    >
  > = {},
) {
  const payloads = params.payloads ?? [{ text: "hello" }];
  return deliverOutboundPayloadsCore({
    cfg: {},
    channel: "line",
    to: "recipient",
    ...params,
    payloads,
    preparedBatch: createUnmodifiedPreparedOutboundBatch(payloads),
  });
}

describe("delivery result reconciliation", () => {
  it("consumes progress once across aggregate receipts and identity-only final results", async () => {
    const first = { channel: "line", messageId: "push", meta: { position: "first" } };
    const otherChannel = { channel: "matrix", messageId: "push" };
    const second = { channel: "line", messageId: "push", meta: { position: "second" } };
    const last = { channel: "line", messageId: "push", meta: { position: "last" } };
    const progress = [first, otherChannel, second, last];
    const aggregate = {
      channel: "line",
      messageId: "push",
      receipt: createMessageReceiptFromOutboundResults({ results: [first, second] }),
    };
    const identityOnly = { channel: "line", messageId: "push", meta: { finalized: true } };
    const unreported = { channel: "line", messageId: "new" };
    const onDeliveryResult = vi.fn();
    installHandler((params) => ({
      sendText: async () => {
        throw new Error("Expected formatted transport");
      },
      sendFormattedText: async () => {
        for (const result of progress) {
          await params.onDeliveryResult?.(result);
        }
        return [aggregate, identityOnly, unreported];
      },
    }));
    const results = await deliver({ onDeliveryResult });

    expect(results).toEqual([aggregate, otherChannel, identityOnly, unreported]);
    expect(onDeliveryResult.mock.calls.map(([result]) => result)).toEqual([
      ...progress,
      unreported,
    ]);
  });

  it("attaches a scalar aggregate to the latest matching progress without erasing earlier sends", async () => {
    const first = { channel: "line", messageId: "push", meta: { position: "first" } };
    const second = { channel: "line", messageId: "push", meta: { position: "second" } };
    const last = { channel: "line", messageId: "push", meta: { position: "last" } };
    const aggregate = {
      channel: "line",
      messageId: "push",
      receipt: createMessageReceiptFromOutboundResults({ results: [second, last] }),
    };
    installHandler((params) => ({
      sendText: async () => {
        for (const result of [first, second, last]) {
          await params.onDeliveryResult?.(result);
        }
        return aggregate;
      },
    }));
    const results = await deliver();

    expect(results).toEqual([first, aggregate]);
  });

  it("retains immutable placement across reconciliation, aliases and payload reset", async () => {
    const nested = { roomId: "reported-room", threadId: "reported-thread" };
    const progress = { channel: "matrix", messageId: "m", raw: [nested] };
    const final: OutboundDeliveryResult = {
      channel: "matrix",
      messageId: "m",
      meta: { hookOwner: true },
    };
    const onDeliveryResult = vi.fn((_result: OutboundDeliveryResult) => {
      nested.roomId = "observer-mutation";
    });
    const next: OutboundDeliveryResult = {
      channel: "matrix",
      messageId: "m",
      target: { kind: "room", id: "next-room" },
    };
    let sends = 0;
    installHandler((params) => ({
      sendText: async () => {
        if (sends++ > 0) {
          return next;
        }
        await params.onDeliveryResult?.(progress);
        nested.threadId = "provider-mutation";
        return final;
      },
    }));
    const placements: DeliveryPlacementEvidence[] = [];
    const results = await deliver({
      channel: "matrix",
      payloads: [{ text: "first" }, { text: "next" }],
      onDeliveryResult,
      onPayloadDeliveryOutcome: (outcome) => {
        if (outcome.status === "sent" && outcome.reportedPlacement) {
          placements.push(outcome.reportedPlacement);
        }
      },
    });
    const first = placements[0]!;
    expect(results).toEqual([final, next]);
    expect(results[0]).toBe(final);
    expect(onDeliveryResult.mock.calls.map(([result]) => result)).toEqual([progress, next]);
    expect(first).toEqual({
      channels: ["matrix"],
      targets: ["reported-room"],
      threads: ["reported-thread"],
      invalid: false,
    });
    expect(Object.isFrozen(first.channels)).toBe(true);
    expect(Object.isFrozen(first.targets)).toBe(true);
    expect(placements[1]).toEqual({
      channels: ["matrix"],
      targets: ["next-room"],
      threads: [],
      invalid: false,
    });
    expect(results).toHaveLength(2);
  });
});
