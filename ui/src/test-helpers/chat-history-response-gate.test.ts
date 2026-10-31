import { describe, expect, it } from "vitest";
import { createHistoryAdmissionRecorder } from "../e2e/chat-history-response-gate.test-support.ts";
import type { RpcMetric } from "../e2e/chat-loading-performance.test-support.ts";

const smallBytes = 256 * 1024;
const sourceRange = (first: number, count: number) =>
  Array.from({ length: count }, (_, index) => first + index);

function packet(
  index: number,
  cursor: string,
  sourceNumbers: number[],
  overrides: Partial<RpcMetric> = {},
): RpcMetric {
  return {
    requestId: `packet-${index}`,
    method: "chat.history",
    cursor,
    limit: 80,
    maxBytes: smallBytes,
    sentMs: index * 10,
    receivedMs: index * 10 + 1,
    historyOk: true,
    historyKind: "window",
    historyBytes: sourceNumbers.length * 100,
    sourceNumbers,
    olderCursor: `older-${index}`,
    newerCursor: `newer-${index}`,
    ...overrides,
  };
}

describe("history admission recorder", () => {
  it.each([
    ["older", 80, smallBytes],
    ["newer", 80, smallBytes],
    ["newer", 400, 3 * 1024 * 1024],
  ] as const)(
    "records small-to-one %s refinement (issued limit %i)",
    (direction, limit, maxBytes) => {
      const first = packet(0, "edge", [10, 11], { limit, maxBytes });
      const retry = packet(1, "edge", [10], { limit: 1 });
      const next = packet(2, direction === "older" ? "older-1" : "newer-1", [12]);
      const recorder = createHistoryAdmissionRecorder(() => [first, retry, next]);

      recorder.record(direction, [10, 12]);

      expect(recorder.receipts).toEqual([
        {
          direction,
          admitted: ["packet-1", "packet-2"],
          refined: ["packet-0"],
          staged: [],
          retired: [],
        },
      ]);
    },
  );

  it.each([400, 80])(
    "records a broad %i-entry budget falling back to canonical small bounds",
    (limit) => {
      const broad = packet(0, "edge", sourceRange(10, limit), {
        limit,
        maxBytes: 3 * 1024 * 1024,
        historyBytes: 300_000,
      });
      const retry = packet(1, "edge", sourceRange(10, 59));
      const recorder = createHistoryAdmissionRecorder(() => [broad, retry]);

      recorder.record("newer", sourceRange(10, 59));

      expect(recorder.receipts).toEqual([
        {
          direction: "newer",
          admitted: ["packet-1"],
          refined: ["packet-0"],
          staged: [],
          retired: [],
        },
      ]);
    },
  );

  it("records the captured broad rejection, six admitted small pages and one staged successor", () => {
    const broad = packet(0, "edge-383", sourceRange(384, 400), {
      limit: 400,
      maxBytes: 3 * 1024 * 1024 - 1,
      historyBytes: 1_768_201,
      newerCursor: "edge-783",
    });
    const small = Array.from({ length: 7 }, (_, index) =>
      packet(index + 1, `edge-${383 + index * 59}`, sourceRange(384 + index * 59, 59), {
        historyBytes: 260_813,
        newerCursor: `edge-${442 + index * 59}`,
      }),
    );
    const recorder = createHistoryAdmissionRecorder(() => [broad, ...small]);
    const oldReaderBridge = sourceRange(338, 46);
    const retained = [...oldReaderBridge, ...sourceRange(384, 354)];

    recorder.record("newer", retained);

    expect(recorder.receipts).toEqual([
      {
        direction: "newer",
        admitted: ["packet-1", "packet-2", "packet-3", "packet-4", "packet-5", "packet-6"],
        refined: ["packet-0"],
        staged: ["packet-7"],
        retired: [],
      },
    ]);
  });

  it.each([
    { name: "small-to-small", first: {}, retry: {} },
    {
      name: "noncanonical broad-to-small byte budget",
      first: { limit: 400, maxBytes: 3 * 1024 * 1024 },
      retry: { maxBytes: smallBytes - 1 },
    },
    {
      name: "increasing entry budget",
      first: { limit: 40, maxBytes: 3 * 1024 * 1024 },
      retry: {},
    },
    {
      name: "increasing byte budget",
      first: { limit: 400, maxBytes: smallBytes - 1 },
      retry: {},
    },
    {
      name: "noncanonical small-to-one byte budget",
      first: {},
      retry: { limit: 1, maxBytes: 1024 },
    },
    {
      name: "wrong retry edge",
      first: { limit: 400, maxBytes: 3 * 1024 * 1024 },
      retry: { cursor: "different-edge" },
    },
  ])("rejects $name", ({ first, retry }) => {
    const recorder = createHistoryAdmissionRecorder(() => [
      packet(0, "edge", [10, 11], first),
      packet(1, "edge", [10], retry),
    ]);

    expect(() => recorder.record("newer", [10])).toThrow();
  });

  it.each([
    { name: "unreceived predecessor", first: { receivedMs: undefined }, retry: {} },
    { name: "unreceived retry", first: {}, retry: { receivedMs: undefined } },
    { name: "failed predecessor", first: { historyOk: false }, retry: {} },
    { name: "failed retry", first: {}, retry: { historyOk: false } },
    { name: "overlapping retry", first: { receivedMs: 11 }, retry: { sentMs: 10 } },
    { name: "missing retry send time", first: {}, retry: { sentMs: undefined } },
    { name: "non-window predecessor", first: { historyKind: "reset" }, retry: {} },
    { name: "non-window retry", first: {}, retry: { historyKind: "delta" } },
  ] satisfies Array<{ name: string; first: Partial<RpcMetric>; retry: Partial<RpcMetric> }>)(
    "rejects $name as refinement evidence",
    ({ first, retry }) => {
      const recorder = createHistoryAdmissionRecorder(() => [
        packet(0, "edge", [10, 11], first),
        packet(1, "edge", [10], { limit: 1, ...retry }),
      ]);

      expect(() => recorder.record("newer", [10])).toThrow();
    },
  );

  it("rejects more than eight foreground packets", () => {
    const history = Array.from({ length: 9 }, (_, index) =>
      packet(index, `edge-${index}`, [index], { newerCursor: `edge-${index + 1}` }),
    );
    const recorder = createHistoryAdmissionRecorder(() => history);

    expect(() => recorder.record("newer", sourceRange(0, 9))).toThrow();
  });

  it("rejects two unadmitted successors instead of certifying partial source coverage", () => {
    const recorder = createHistoryAdmissionRecorder(() => [
      packet(0, "edge-0", [1], { newerCursor: "edge-1" }),
      packet(1, "edge-1", [2, 3], { newerCursor: "edge-2" }),
      packet(2, "edge-2", [4]),
    ]);

    expect(() => recorder.record("newer", [1, 2])).toThrow();
  });

  it.each([
    { name: "both axes", direction: "older", limit: 354, maxBytes: 2_900_000 },
    { name: "entry axis only", direction: "newer", limit: 354, maxBytes: 3 * 1024 * 1024 },
    { name: "byte axis only", direction: "newer", limit: 400, maxBytes: 2_900_000 },
  ])("records strict adaptive narrowing of $name", ({ direction, limit, maxBytes }) => {
    const broad = packet(0, "edge", sourceRange(10, 400), {
      limit: 400,
      maxBytes: 3 * 1024 * 1024,
    });
    const retry = packet(1, "edge", sourceRange(10, 354), { limit, maxBytes });
    const recorder = createHistoryAdmissionRecorder(() => [broad, retry]);

    recorder.record(direction, sourceRange(10, 354));

    expect(recorder.receipts).toEqual([
      {
        direction,
        admitted: ["packet-1"],
        refined: ["packet-0"],
        staged: [],
        retired: [],
      },
    ]);
  });

  it.each([
    { name: "unchanged adaptive bounds", first: {}, retry: {} },
    { name: "growing adaptive entries", first: {}, retry: { limit: 401, maxBytes: 2_900_000 } },
    {
      name: "growing adaptive bytes",
      first: {},
      retry: { limit: 354, maxBytes: 3 * 1024 * 1024 + 1 },
    },
    {
      name: "fractional issued entries",
      first: { limit: 400.5 },
      retry: { limit: 354, maxBytes: 2_900_000 },
    },
    {
      name: "fractional issued bytes",
      first: { maxBytes: 3 * 1024 * 1024 - 0.5 },
      retry: { limit: 354, maxBytes: 2_900_000 },
    },
    { name: "fractional retry entries", first: {}, retry: { limit: 354.5, maxBytes: 2_900_000 } },
    { name: "fractional retry bytes", first: {}, retry: { limit: 354, maxBytes: 2_900_000.5 } },
    {
      name: "adaptive entries with small bytes",
      first: {},
      retry: { limit: 354, maxBytes: smallBytes },
    },
    {
      name: "small entries with adaptive bytes",
      first: {},
      retry: { limit: 80, maxBytes: 2_900_000 },
    },
  ] satisfies Array<{ name: string; first: Partial<RpcMetric>; retry: Partial<RpcMetric> }>)(
    "rejects $name",
    ({ first, retry }) => {
      const recorder = createHistoryAdmissionRecorder(() => [
        packet(0, "edge", [10, 11], { limit: 400, maxBytes: 3 * 1024 * 1024, ...first }),
        packet(1, "edge", [10], { limit: 400, maxBytes: 3 * 1024 * 1024, ...retry }),
      ]);

      expect(() => recorder.record("newer", [10])).toThrow();
    },
  );
});
