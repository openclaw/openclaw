// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { SessionActivityController } from "./session-activity-controller.ts";

const result = {
  ts: 1,
  path: "",
  count: 0,
  sessions: [],
  defaults: { model: null, modelProvider: null, contextTokens: null },
};
let client: GatewayBrowserClient;
let controller: SessionActivityController;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  controller = new SessionActivityController(() => {});
});
afterEach(() => {
  controller.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("requests calendar-aligned pulse windows, including clock-change dates", async () => {
  const request = vi.spyOn(client, "request").mockResolvedValue(result);
  const windows = [
    [
      "24h",
      new Date(2026, 8, 27, 14, 30),
      26,
      new Date(2026, 8, 26, 14),
      new Date(2026, 8, 27, 15),
      1440,
    ],
    ["7d", new Date(2026, 8, 27, 14, 30), 9, new Date(2026, 8, 20), new Date(2026, 8, 28), 10080],
    ["30d", new Date(2026, 8, 27, 14, 30), 32, new Date(2026, 7, 28), new Date(2026, 8, 28), 43200],
    [
      "all",
      new Date(2026, 8, 27, 14, 30),
      13,
      new Date(2025, 9, 1),
      new Date(2026, 9, 1),
      undefined,
    ],
    ["24h", new Date(2026, 3, 5, 15, 30), 26, null, new Date(2026, 3, 5, 16), 1440],
    ["24h", new Date(2026, 9, 4, 15, 30), 26, null, new Date(2026, 9, 4, 16), 1440],
    ["7d", new Date(2026, 2, 10, 12), 9, new Date(2026, 2, 3), new Date(2026, 2, 11), 10080],
    ["7d", new Date(2026, 10, 3, 12), 9, new Date(2026, 9, 27), new Date(2026, 10, 4), 10080],
  ] as const;
  for (const [index, [time, now, count, first, last, activeMinutes]] of windows.entries()) {
    vi.setSystemTime(now);
    await controller.load(client, { personId: null, time, query: "" });
    expect(request).toHaveBeenCalledTimes(index + 1);
    const params = request.mock.calls[index]![1] as {
      activityPulseBoundaries: number[];
      activeMinutes?: number;
    };
    const boundaries = params.activityPulseBoundaries;
    const oldest = new Date(now.getTime() - 24 * 3_600_000);
    expect(boundaries).toHaveLength(count);
    expect(boundaries[0]).toBe(
      (
        first ??
        new Date(oldest.getFullYear(), oldest.getMonth(), oldest.getDate(), oldest.getHours())
      ).getTime(),
    );
    expect(boundaries.at(-1)).toBe(last.getTime());
    expect(boundaries.every((value, i) => i === 0 || value > boundaries[i - 1]!)).toBe(true);
    expect(params.activeMinutes).toBe(activeMinutes);
    expect(params).not.toHaveProperty("activityPulseSince");
    expect(params).not.toHaveProperty("activityPulseUntil");
    for (const [i, boundary] of boundaries.entries()) {
      const date = new Date(boundary);
      expect([date.getMinutes(), date.getSeconds(), date.getMilliseconds()]).toEqual([0, 0, 0]);
      if (time !== "24h") {
        expect(date.getHours()).toBe(0);
      }
      if (time === "all") {
        expect(date.getDate()).toBe(1);
      }
      if (time === "7d") {
        expect(boundary).toBe(
          new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7 + i).getTime(),
        );
      }
    }
  }
});

it.each([
  { time: "24h", month: 8, day: 27, hour: 14 },
  { time: "7d", month: 2, day: 8, hour: 23 },
  { time: "30d", month: 10, day: 1, hour: 23 },
  { time: "all", month: 8, day: 27, hour: 23 },
] as const)(
  "refreshes $time at the bucket end or next midnight and leaves current work unaggregated",
  async ({ time, month, day, hour }) => {
    vi.setSystemTime(new Date(2026, month, day, hour, 59));
    const request = vi.spyOn(client, "request").mockResolvedValue(result);
    const filters = { personId: null, time, query: "" };
    await controller.load(client, filters);
    const { activityPulseBoundaries: initial } = request.mock.calls[0]![1] as {
      activityPulseBoundaries: number[];
    };
    await controller.load(client, filters);
    expect(request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(request).toHaveBeenCalledTimes(2);
    const { activityPulseBoundaries: refreshed } = request.mock.calls[1]![1] as {
      activityPulseBoundaries: number[];
    };
    if (time === "all") {
      expect(refreshed).toEqual(initial);
    } else {
      expect(refreshed.slice(0, -1)).toEqual(initial.slice(1));
      expect(refreshed.at(-1)).toBeGreaterThan(initial.at(-1)!);
    }

    await controller.load(client, "current");
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("activityPulseBoundaries");
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(request).toHaveBeenCalledTimes(3);

    await controller.load(client, filters);
    expect(request).toHaveBeenCalledTimes(4);
    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(request).toHaveBeenCalledTimes(4);
  },
);

it.each([
  { action: "retry", phase: "pending" },
  { action: "retry", phase: "cooldown" },
  { action: "filter", phase: "pending" },
  { action: "filter", phase: "cooldown" },
])("bypasses automatic Activity $phase for an explicit $action", async ({ action, phase }) => {
  const replacement = { ...result, ts: 2 };
  const stale = createDeferred<typeof result>();
  const request = vi
    .spyOn(client, "request")
    .mockResolvedValueOnce(result)
    .mockReturnValueOnce(stale.promise)
    .mockResolvedValue(replacement);
  try {
    const filters = { personId: null, time: "all" as const, query: "" };
    void controller.load(client, filters);
    await vi.advanceTimersByTimeAsync(0);
    controller.invalidate();
    await vi.advanceTimersByTimeAsync(5_000);
    controller.invalidate();
    if (phase === "cooldown") {
      await vi.advanceTimersByTimeAsync(1_000);
      stale.resolve(result);
      await vi.advanceTimersByTimeAsync(0);
    }
    void controller.load(
      client,
      action === "filter" ? { ...filters, query: "replacement" } : filters,
      action === "retry" ? "retry" : "query",
    );
    expect(request).toHaveBeenCalledTimes(3);
    if (phase === "pending") {
      expect(request.mock.calls[1]![2]?.signal?.aborted).toBe(true);
    }
    await vi.advanceTimersByTimeAsync(0);
    stale.resolve(result);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(controller.result).toEqual(replacement);
    expect(request).toHaveBeenCalledTimes(3);
  } finally {
    stale.resolve(result);
  }
});

it("keeps the same-query snapshot during invalidation and clears it on person changes", async () => {
  const resolved = { ...result, involvingProfileId: "current" };
  const request = vi.spyOn(client, "request").mockResolvedValue(resolved);
  const filters = { personId: "former", time: "all" as const, query: "" };
  await controller.load(client, filters);
  expect(controller.result).toEqual(resolved);
  void controller.load(client, filters, "refresh");
  expect(controller.result).toEqual(resolved);
  expect(request).toHaveBeenLastCalledWith(
    "sessions.list",
    expect.objectContaining({
      involvingProfileId: "former",
      excludeDock: true,
      includePeople: true,
      sortBy: "activity",
    }),
    expect.anything(),
  );
  void controller.load(client, { ...filters, personId: "other" });
  expect(controller.result).toBeUndefined();
  controller.dispose();
});

it("holds a trailing Activity refresh through page hiding and retires it on disconnect", async () => {
  const documentEvents = new EventTarget();
  const pageEvents = new EventTarget();
  let visibilityState = "visible";
  Object.defineProperty(documentEvents, "visibilityState", { get: () => visibilityState });
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("addEventListener", pageEvents.addEventListener.bind(pageEvents));
  vi.stubGlobal("removeEventListener", pageEvents.removeEventListener.bind(pageEvents));
  controller = new SessionActivityController(() => {});
  let complete!: (value: typeof result) => void;
  const pending = new Promise<typeof result>((resolve) => {
    complete = resolve;
  });
  const request = vi.spyOn(client, "request").mockResolvedValue(result);
  try {
    controller.connect();
    const filters = { personId: null, time: "7d" as const, query: "" };
    void controller.load(client, filters);
    await vi.advanceTimersByTimeAsync(0);
    request.mockReturnValueOnce(pending);
    void controller.load(client, filters, "refresh");
    controller.invalidate();
    await vi.advanceTimersByTimeAsync(5_000);
    visibilityState = "hidden";
    documentEvents.dispatchEvent(new Event("visibilitychange"));
    complete(result);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(2);
    visibilityState = "visible";
    documentEvents.dispatchEvent(new Event("visibilitychange"));
    pageEvents.dispatchEvent(new Event("pageshow"));
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(3);
    controller.invalidate();
    controller.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(3);
  } finally {
    complete(result);
  }
});
