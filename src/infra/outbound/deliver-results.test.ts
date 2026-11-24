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

type DeliveryOptions = Partial<
  Pick<
    DeliverOutboundPayloadsCoreParams,
    "channel" | "payloads" | "onDeliveryResult" | "onPayloadDeliveryOutcome"
  >
>;
async function unexpectedSend(): Promise<never> {
  throw new Error("Unexpected transport");
}
function deliver(
  send: (
    params: ChannelHandlerParams,
  ) => Partial<Pick<ChannelHandler, "sendText" | "sendFormattedText">>,
  options: DeliveryOptions = {},
) {
  vi.mocked(createChannelHandler).mockImplementation(async (params) => ({
    chunker: null,
    supportsMedia: false,
    buildTargetRef: () => ({ channel: params.channel, to: params.to }),
    sendMedia: unexpectedSend,
    sendText: unexpectedSend,
    ...send(params),
  }));
  const payloads = options.payloads ?? [{ text: "hello" }];
  return deliverOutboundPayloadsCore({
    cfg: {},
    channel: "line",
    to: "recipient",
    ...options,
    payloads,
    preparedBatch: createUnmodifiedPreparedOutboundBatch(payloads),
  });
}

function progressResult(position: string) {
  return { channel: "line", messageId: "push", meta: { position } };
}

describe("delivery result reconciliation", () => {
  it.each([true, false])("reconciles aggregate receipts (formatted: %s)", async (formatted) => {
    const first = progressResult("first"),
      second = progressResult("second"),
      last = progressResult("last");
    const otherChannel = { channel: "matrix", messageId: "push" };
    const progress = formatted ? [first, otherChannel, second, last] : [first, second, last];
    const aggregate = {
      channel: "line",
      messageId: "push",
      receipt: createMessageReceiptFromOutboundResults({
        results: formatted ? [first, second] : [second, last],
      }),
    };
    const identityOnly = { channel: "line", messageId: "push", meta: { finalized: true } };
    const unreported = { channel: "line", messageId: "new" };
    const onDeliveryResult = vi.fn();
    const results = await deliver(
      (params) => {
        const send = async () => {
          for (const result of progress) {
            await params.onDeliveryResult?.(result);
          }
          return aggregate;
        };
        return formatted
          ? {
              sendFormattedText: async () => {
                await send();
                return [aggregate, identityOnly, unreported];
              },
            }
          : {
              sendText: send,
            };
      },
      formatted ? { onDeliveryResult } : {},
    );

    expect(results).toEqual(
      formatted ? [aggregate, otherChannel, identityOnly, unreported] : [first, aggregate],
    );
    if (formatted) {
      expect(onDeliveryResult.mock.calls.map(([result]) => result)).toEqual([
        ...progress,
        unreported,
      ]);
    }
  });

  it("retains immutable placement across reconciliation, aliases and payload reset", async () => {
    const nested = { roomId: "reported-room", threadId: "reported-thread" };
    const identity = { channel: "matrix", messageId: "m" };
    const progress = { ...identity, raw: [nested] };
    const final = { ...identity, meta: { hookOwner: true } };
    const onDeliveryResult = vi.fn((_result: OutboundDeliveryResult) => {
      nested.roomId = "observer-mutation";
    });
    const next: OutboundDeliveryResult = {
      ...identity,
      target: { kind: "room", id: "next-room" },
    };
    let sends = 0;
    const placements: DeliveryPlacementEvidence[] = [];
    const results = await deliver(
      (params) => ({
        sendText: async () => {
          if (sends++ > 0) {
            return next;
          }
          await params.onDeliveryResult?.(progress);
          nested.threadId = "provider-mutation";
          return final;
        },
      }),
      {
        channel: "matrix",
        payloads: [{ text: "first" }, { text: "next" }],
        onDeliveryResult,
        onPayloadDeliveryOutcome: (outcome) => {
          if (outcome.status === "sent" && outcome.reportedPlacement) {
            placements.push(outcome.reportedPlacement);
          }
        },
      },
    );
    expect(results).toEqual([final, next]);
    expect(results[0]).toBe(final);
    expect(onDeliveryResult.mock.calls.map(([result]) => result)).toEqual([progress, next]);
    const placement = { channels: ["matrix"], invalid: false };
    expect(placements).toEqual([
      { ...placement, targets: ["reported-room"], threads: ["reported-thread"] },
      { ...placement, targets: ["next-room"], threads: [] },
    ]);
    expect(Object.isFrozen(placements[0]!.channels)).toBe(true);
    expect(Object.isFrozen(placements[0]!.targets)).toBe(true);
  });
});
