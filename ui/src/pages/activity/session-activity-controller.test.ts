// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  sessionActivityListing,
  useSessionActivityControllerFixture,
} from "./session-activity-controller.test-support.ts";
import { createSessionActivity } from "./session-activity-owner.ts";

const result = sessionActivityListing([]);
const { active, setup } = useSessionActivityControllerFixture();
let client: ReturnType<typeof setup>["client"];
let controller: ReturnType<typeof createSessionActivity>;
const dayAt = (month: number, day: number, hour = 0, minute = 0, year = 2026) =>
  new Date(year, month, day, hour, minute);
let request: ReturnType<typeof setup>["request"];
let held: ReturnType<typeof createDeferred<typeof result>>;
const pulse = (index: number) =>
  request.mock.calls[index]![1] as { activityPulseBoundaries: number[]; activeMinutes?: number };
const advance = async (ms: number, calls: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  expect(request).toHaveBeenCalledTimes(calls);
};
beforeEach(() => {
  vi.useFakeTimers();
  ({ client, controller, request } = setup());
  request.mockResolvedValue(result);
  held = createDeferred<typeof result>();
});
afterEach(() => {
  held.resolve(result);
  controller.dispose();
  vi.unstubAllGlobals();
});

it("reconstructs conditional Activity rows before reconciling fresh metadata", async () => {
  const filters = { personId: null, time: "all" as const, query: "" };
  request.mockResolvedValueOnce(sessionActivityListing([active], { rowsRevision: "first" }));
  await controller.load(client, filters);
  request.mockResolvedValueOnce(
    sessionActivityListing([], {
      rowsRevision: "first",
      rowsUnchanged: true,
      count: 1,
      totalCount: 20,
    }),
  );
  await controller.load(client, filters, "refresh");
  expect(request).toHaveBeenLastCalledWith(
    "sessions.list",
    expect.objectContaining({ ifRowsRevision: "delta:first" }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(controller.result).toMatchObject({ sessions: [active], totalCount: 20 });
  const renamed = { ...active, label: "Renamed" };
  request.mockResolvedValueOnce(
    sessionActivityListing([renamed], {
      rowsRevision: "next",
      rowsDelta: { baseRevision: "first", order: [1] },
    }),
  );
  await controller.load(client, filters, "refresh");
  expect(controller.result?.sessions).toEqual([renamed]);
});

it("requests calendar-aligned pulse windows, including clock-change dates", async () => {
  const windows = [
    ["24h", dayAt(8, 27, 14, 30), 26, dayAt(8, 26, 14), dayAt(8, 27, 15), 1440],
    ["7d", dayAt(8, 27, 14, 30), 9, dayAt(8, 20), dayAt(8, 28), 10080],
    ["30d", dayAt(8, 27, 14, 30), 32, dayAt(7, 28), dayAt(8, 28), 43200],
    ["all", dayAt(8, 27, 14, 30), 13, dayAt(9, 1, 0, 0, 2025), dayAt(9, 1), undefined],
    ["24h", dayAt(3, 5, 15, 30), 26, null, dayAt(3, 5, 16), 1440],
    ["24h", dayAt(9, 4, 15, 30), 26, null, dayAt(9, 4, 16), 1440],
    ["7d", dayAt(2, 10, 12), 9, dayAt(2, 3), dayAt(2, 11), 10080],
    ["7d", dayAt(10, 3, 12), 9, dayAt(9, 27), dayAt(10, 4), 10080],
  ] as const;
  for (const [index, [time, now, count, first, last, activeMinutes]] of windows.entries()) {
    vi.setSystemTime(now);
    await controller.load(client, { personId: null, time, query: "" });
    expect(request).toHaveBeenCalledTimes(index + 1);
    const params = pulse(index);
    const boundaries = params.activityPulseBoundaries;
    const oldest = new Date(now.getTime() - 24 * 3_600_000);
    oldest.setMinutes(0, 0, 0);
    expect(boundaries).toHaveLength(count);
    expect(boundaries[0]).toBe((first ?? oldest).getTime());
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
    const filters = { personId: null, time, query: "" };
    await controller.load(client, filters);
    const { activityPulseBoundaries: initial } = pulse(0);
    await controller.load(client, filters);
    expect(request).toHaveBeenCalledTimes(1);

    await advance(60_999, 1);
    await advance(5_001, 2);
    const { activityPulseBoundaries: refreshed } = pulse(1);
    if (time === "all") {
      expect(refreshed).toEqual(initial);
    } else {
      expect(refreshed.slice(0, -1)).toEqual(initial.slice(1));
      expect(refreshed.at(-1)).toBeGreaterThan(initial.at(-1)!);
    }

    await controller.load(client, "current");
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("activityPulseBoundaries");
    await advance(24 * 3_600_000, 3);

    await controller.load(client, filters);
    expect(request).toHaveBeenCalledTimes(4);
    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await advance(24 * 3_600_000, 4);
  },
);

it.each([
  { action: "retry", phase: "pending" },
  { action: "retry", phase: "cooldown" },
  { action: "filter", phase: "pending" },
  { action: "filter", phase: "cooldown" },
])("bypasses automatic Activity $phase for an explicit $action", async ({ action, phase }) => {
  const replacement = { ...result, ts: 2 };
  request
    .mockResolvedValueOnce(result)
    .mockReturnValueOnce(held.promise)
    .mockResolvedValue(replacement);
  const filters = { personId: null, time: "all" as const, query: "" };
  void controller.load(client, filters);
  await vi.advanceTimersByTimeAsync(0);
  controller.invalidate();
  await vi.advanceTimersByTimeAsync(5_000);
  controller.invalidate();
  if (phase === "cooldown") {
    await vi.advanceTimersByTimeAsync(1_000);
    held.resolve(result);
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
  held.resolve(result);
  await advance(15_000, 3);
  expect(controller.result).toEqual(replacement);
});

it("keeps the same-query snapshot during invalidation and clears it on person changes", async () => {
  const resolved = { ...result, involvingProfileId: "current" };
  request.mockResolvedValue(resolved);
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
});

it("holds a trailing Activity refresh through page hiding and retires it on disconnect", async () => {
  const documentEvents = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const pageEvents = new EventTarget();
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("addEventListener", pageEvents.addEventListener.bind(pageEvents));
  vi.stubGlobal("removeEventListener", pageEvents.removeEventListener.bind(pageEvents));
  controller = createSessionActivity(() => {});
  const filters = { personId: null, time: "7d" as const, query: "" };
  void controller.load(client, filters);
  await vi.advanceTimersByTimeAsync(0);
  request.mockReturnValueOnce(held.promise);
  void controller.load(client, filters, "refresh");
  controller.invalidate();
  await vi.advanceTimersByTimeAsync(5_000);
  documentEvents.visibilityState = "hidden";
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  held.resolve(result);
  await advance(5_000, 2);
  documentEvents.visibilityState = "visible";
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  pageEvents.dispatchEvent(new Event("pageshow"));
  await advance(0, 3);
  controller.invalidate();
  controller.dispose();
  await advance(5_000, 3);
});
