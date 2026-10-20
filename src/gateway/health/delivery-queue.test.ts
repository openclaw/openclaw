import { beforeEach, describe, expect, it, vi } from "vitest";
import * as deliveryQueueState from "../../infra/delivery-queue-sqlite.js";

const countOutbound = vi.fn();
const countIngress = vi.fn();

vi.mock("../../infra/delivery-queue-sqlite.js", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("../../infra/delivery-queue-sqlite.js")>()),
    countFailedDeliveryQueueEntries: () => countOutbound(),
  };
});

vi.mock("../../channels/message/ingress-queue-health.js", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("../../channels/message/ingress-queue-health.js")>()),
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
    [
      "outbound failures on ingress rejection",
      outboundFailed,
      new Error("ingress unavailable"),
      { failed: outboundFailed },
    ],
    [
      "ingress failures on outbound rejection",
      new Error("outbound unavailable"),
      { failed: ingressFailed, pressure: [] },
      { failed: [], ingressFailed },
    ],
    [
      "dead letters on pressure failure",
      [],
      { failed: ingressFailed, pressure: [], errors: { pressure: "unavailable" } },
      { failed: [], ingressFailed },
    ],
    [
      "pressure on dead-letter failure",
      [],
      { failed: [], pressure: ingressPressure, errors: { failed: "unavailable" } },
      { failed: [], ingressPressure },
    ],
  ])("preserves %s", async (_name, outbound, ingress, expected) => {
    for (const [mock, value] of [
      [countOutbound, outbound],
      [countIngress, ingress],
    ] as const) {
      if (value instanceof Error) {
        mock.mockRejectedValue(value);
      } else {
        mock.mockResolvedValue(value);
      }
    }
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
