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

it("reads ingress health without waiting for outbound storage", async () => {
  const outbound = Promise.withResolvers<typeof outboundFailed>();
  countOutbound.mockReturnValueOnce(outbound.promise);
  countIngress.mockResolvedValueOnce({ failed: ingressFailed, pressure: [] });
  const summary = buildDeliveryQueueHealthSummary();
  try {
    expect(countIngress).toHaveBeenCalledTimes(1);
  } finally {
    outbound.resolve(outboundFailed);
    await summary;
  }
  expect(await summary).toEqual({ failed: outboundFailed, ingressFailed });
});

it.each([
  [
    "outbound failures on ingress rejection",
    outboundFailed,
    new Error("ingress unavailable"),
    { failed: outboundFailed, unavailable: ["ingressFailed", "ingressPressure"] },
  ],
  [
    "ingress failures on outbound rejection",
    new Error("outbound unavailable"),
    { failed: ingressFailed, pressure: [] },
    { failed: [], ingressFailed, unavailable: ["outbound"] },
  ],
  [
    "dead letters on pressure failure",
    [],
    { failed: ingressFailed, pressure: [], errors: { pressure: "unavailable" } },
    { failed: [], ingressFailed, unavailable: ["ingressPressure"] },
  ],
  [
    "pressure on dead-letter failure",
    [],
    { failed: [], pressure: ingressPressure, errors: { failed: "unavailable" } },
    { failed: [], ingressPressure, unavailable: ["ingressFailed"] },
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

it("keeps unavailable outbound health visible when every returned count is empty", async () => {
  countOutbound.mockRejectedValueOnce(new Error("private storage details"));
  const summary = await buildDeliveryQueueHealthSummary();
  expect(summary).toEqual({ failed: [], unavailable: ["outbound"] });
  expect(JSON.stringify(summary)).not.toContain("private storage details");
});

it("keeps both unavailable stores visible without failing gateway health", async () => {
  countOutbound.mockRejectedValueOnce(new Error("private outbound"));
  countIngress.mockRejectedValueOnce(new Error("private ingress"));
  expect(await buildDeliveryQueueHealthSummary()).toEqual({
    failed: [],
    unavailable: ["ingressFailed", "ingressPressure", "outbound"],
  });
});

it("does not read a different store when capture of the requested state failed", async () => {
  expect(await buildDeliveryQueueHealthSummary({ error: new Error("private context") })).toEqual({
    failed: [],
    unavailable: ["ingressFailed", "ingressPressure", "outbound"],
  });
  expect(countOutbound).not.toHaveBeenCalled();
  expect(countIngress).not.toHaveBeenCalled();
});

it("omits diagnostic health only after both stores were read successfully and were empty", async () => {
  expect(await buildDeliveryQueueHealthSummary()).toBeUndefined();
  expect(countOutbound).toHaveBeenCalledTimes(1);
  expect(countIngress).toHaveBeenCalledTimes(1);
});

it.each([
  ["failed", "ingressFailed"],
  ["pressure", "ingressPressure"],
] as const)(
  "preserves a present empty %s error without exposing it",
  async (field, unavailable) => {
    countIngress.mockResolvedValueOnce({ failed: [], pressure: [], errors: { [field]: "" } });
    expect(await buildDeliveryQueueHealthSummary()).toEqual({
      failed: [],
      unavailable: [unavailable],
    });
  },
);

it("does not turn absent optional error values into an unavailable store", async () => {
  countIngress.mockResolvedValueOnce({
    failed: [],
    pressure: [],
    errors: { failed: undefined, pressure: undefined },
  });
  expect(await buildDeliveryQueueHealthSummary()).toBeUndefined();
});
