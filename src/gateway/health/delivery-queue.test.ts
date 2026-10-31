import { afterAll, beforeEach, expect, it, vi } from "vitest";
import * as ingressHealth from "../../channels/message/ingress-queue-health.js";
import * as deliveryQueueState from "../../infra/delivery-queue-sqlite.js";
import { buildDeliveryQueueHealthSummary } from "./delivery-queue.js";
import { createTelegramIngressPressure } from "./delivery-queue.test-support.js";

const countOutbound = vi.fn();
const countIngress = vi.fn();

vi.spyOn(deliveryQueueState, "countFailedDeliveryQueueEntries").mockImplementation(() =>
  countOutbound(),
);
vi.spyOn(ingressHealth, "countChannelIngressQueueHealth").mockImplementation(() => countIngress());
afterAll(() => vi.restoreAllMocks());
const outboundFailed = [{ queueName: "outbound", count: 2, oldestFailedAt: 1_000 }];
const ingressFailed = [
  { channelId: "telegram", accountId: "ops", count: 1, oldestFailedAt: 2_000 },
];
const ingressPressure = createTelegramIngressPressure();

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
