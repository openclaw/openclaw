// Delivery queue health tests cover independent inbound and outbound diagnostic reads.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as deliveryQueueState from "../../infra/delivery-queue-sqlite.js";

const countOutbound = vi.fn();
const countIngress = vi.fn();

vi.mock("../../infra/delivery-queue-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/delivery-queue-sqlite.js")>();
  return {
    ...actual,
    countFailedDeliveryQueueEntries: () => countOutbound(),
  };
});

vi.mock("../../channels/message/ingress-queue-health.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../channels/message/ingress-queue-health.js")>();
  return {
    ...actual,
    countChannelIngressQueueHealth: () => countIngress(),
  };
});

const { buildDeliveryQueueHealthSummary } = await import("./delivery-queue.js");
const outboundFailed = [{ queueName: "outbound", count: 2, oldestFailedAt: 1_000 }];
const ingressFailed = [
  { channelId: "telegram", accountId: "ops", count: 1, oldestFailedAt: 2_000 },
];
const ingressPressure = [
  {
    channelId: "telegram",
    accountId: "ops",
    laneCount: 1,
    pendingCount: 56,
    claimedCount: 0,
    blockedCount: 55,
    oldestReceivedAt: 1_000,
  },
];

describe("buildDeliveryQueueHealthSummary", () => {
  beforeEach(() => {
    countOutbound.mockReset().mockResolvedValue([]);
    countIngress.mockReset().mockResolvedValue({ failed: [], pressure: [] });
  });

  it.each([
    {
      name: "outbound failures when the ingress dead-letter read fails",
      arrange: () => {
        countOutbound.mockResolvedValue(outboundFailed);
        countIngress.mockRejectedValue(new Error("ingress database unavailable"));
      },
      expected: { failed: outboundFailed },
    },
    {
      name: "ingress failures when the outbound read fails",
      arrange: () => {
        countOutbound.mockRejectedValue(new Error("outbound database unavailable"));
        countIngress.mockResolvedValue({ failed: ingressFailed, pressure: [] });
      },
      expected: { failed: [], ingressFailed },
    },
    {
      name: "dead letters when the ingress pressure read fails",
      arrange: () => {
        countIngress.mockResolvedValue({
          failed: ingressFailed,
          pressure: [],
          errors: { pressure: "ingress pressure read unavailable" },
        });
      },
      expected: { failed: [], ingressFailed },
    },
    {
      name: "ingress pressure when the dead-letter read fails",
      arrange: () => {
        countIngress.mockResolvedValue({
          failed: [],
          pressure: ingressPressure,
          errors: { failed: "ingress failed read unavailable" },
        });
      },
      expected: { failed: [], ingressPressure },
    },
  ])("preserves $name", async ({ arrange, expected }) => {
    arrange();
    expect(await buildDeliveryQueueHealthSummary()).toEqual(expected);
  });

  it("preserves ingress diagnostics when outbound admission capture fails", async () => {
    const capture = vi
      .spyOn(deliveryQueueState, "captureDeliveryQueueStateContext")
      .mockImplementation(() => {
        throw new Error("outbound admission unavailable");
      });
    countIngress.mockResolvedValue({ failed: ingressFailed, pressure: ingressPressure });
    try {
      expect(await buildDeliveryQueueHealthSummary()).toEqual({
        failed: [],
        ingressFailed,
        ingressPressure,
      });
      expect(capture).toHaveBeenCalledTimes(1);
      expect(countOutbound).not.toHaveBeenCalled();
    } finally {
      capture.mockRestore();
    }
  });
});
