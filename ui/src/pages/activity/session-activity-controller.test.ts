// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { activityPulseBoundaries } from "./activity-pulse-window.ts";
import { SessionActivityController } from "./session-activity-controller.ts";

it.each([
  { month: 3, day: 5 },
  { month: 9, day: 4 },
])("aligns hourly windows across partial-hour clock changes ($month/$day)", ({ month, day }) => {
  const now = new Date(2026, month, day, 15, 30);
  const oldest = new Date(now.getTime() - 24 * 3_600_000);
  const boundaries = activityPulseBoundaries("24h", now.getTime());
  expect(boundaries[0]).toBe(
    new Date(
      oldest.getFullYear(),
      oldest.getMonth(),
      oldest.getDate(),
      oldest.getHours(),
    ).getTime(),
  );
  expect(boundaries.at(-1)).toBe(new Date(2026, month, day, 16).getTime());
  expect(boundaries.every((value, index) => index === 0 || value > boundaries[index - 1]!)).toBe(
    true,
  );
});

it("changes pulse boundaries with the selected time window", async () => {
  vi.useFakeTimers();
  const now = new Date(2026, 8, 27, 14, 30);
  vi.setSystemTime(now);
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const request = vi.spyOn(client, "request").mockResolvedValue({
    ts: 1,
    path: "",
    count: 0,
    sessions: [],
    defaults: { model: null, modelProvider: null, contextTokens: null },
  });
  const controller = new SessionActivityController({
    addController() {},
    removeController() {},
    requestUpdate() {},
    updateComplete: Promise.resolve(true),
  });
  try {
    const windows = [
      {
        time: "24h",
        count: 26,
        first: new Date(2026, 8, 26, 14),
        last: new Date(2026, 8, 27, 15),
        activeMinutes: 1440,
      },
      {
        time: "7d",
        count: 9,
        first: new Date(2026, 8, 20),
        last: new Date(2026, 8, 28),
        activeMinutes: 10080,
      },
      {
        time: "30d",
        count: 32,
        first: new Date(2026, 7, 28),
        last: new Date(2026, 8, 28),
        activeMinutes: 43200,
      },
      {
        time: "all",
        count: 13,
        first: new Date(2025, 9, 1),
        last: new Date(2026, 9, 1),
        activeMinutes: undefined,
      },
    ] as const;
    for (const [index, window] of windows.entries()) {
      await controller.load(client, { personId: null, time: window.time, query: "" });
      expect(request).toHaveBeenCalledTimes(index + 1);
      const params = request.mock.calls[index]![1] as {
        activityPulseBoundaries: number[];
        activeMinutes?: number;
      };
      const boundaries = params.activityPulseBoundaries;
      expect(boundaries).toHaveLength(window.count);
      expect(boundaries[0]).toBe(window.first.getTime());
      expect(boundaries.at(-1)).toBe(window.last.getTime());
      expect(boundaries.every((value, i) => i === 0 || value > boundaries[i - 1]!)).toBe(true);
      expect(params.activeMinutes).toBe(window.activeMinutes);
      expect(params).not.toHaveProperty("activityPulseSince");
      expect(params).not.toHaveProperty("activityPulseUntil");
      for (const boundary of boundaries) {
        const date = new Date(boundary);
        expect([date.getMinutes(), date.getSeconds(), date.getMilliseconds()]).toEqual([0, 0, 0]);
        if (window.time !== "24h") {
          expect(date.getHours()).toBe(0);
        }
        if (window.time === "all") {
          expect(date.getDate()).toBe(1);
        }
      }
    }
  } finally {
    controller.hostDisconnected();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

it.each([
  { month: 2, day: 10 },
  { month: 10, day: 3 },
])(
  "keeps daily boundaries at local midnight across clock changes ($month/$day)",
  async ({ month, day }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, month, day, 12));
    const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
    const request = vi.spyOn(client, "request").mockResolvedValue({ sessions: [] });
    const controller = new SessionActivityController({
      addController() {},
      removeController() {},
      requestUpdate() {},
      updateComplete: Promise.resolve(true),
    });
    try {
      await controller.load(client, { personId: null, time: "7d", query: "" });
      const { activityPulseBoundaries: boundaries } = request.mock.calls[0]![1] as {
        activityPulseBoundaries: number[];
      };
      expect(boundaries).toHaveLength(9);
      for (const [index, boundary] of boundaries.entries()) {
        expect(boundary).toBe(new Date(2026, month, day - 7 + index).getTime());
      }
    } finally {
      controller.hostDisconnected();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  },
);

it.each([
  { time: "24h", month: 8, day: 27, hour: 14 },
  { time: "7d", month: 2, day: 8, hour: 23 },
  { time: "30d", month: 10, day: 1, hour: 23 },
  { time: "all", month: 8, day: 27, hour: 23 },
] as const)(
  "refreshes $time at the bucket end or next midnight and leaves current work unaggregated",
  async ({ time, month, day, hour }) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.setSystemTime(new Date(2026, month, day, hour, 59));
    const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
    const request = vi.spyOn(client, "request").mockResolvedValue({
      ts: 1,
      path: "",
      count: 0,
      sessions: [],
      defaults: { model: null, modelProvider: null, contextTokens: null },
    });
    const controller = new SessionActivityController({
      addController() {},
      removeController() {},
      requestUpdate() {},
      updateComplete: Promise.resolve(true),
    });
    const filters = { personId: null, time, query: "" };
    try {
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
      controller.hostDisconnected();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(24 * 3_600_000);
      expect(request).toHaveBeenCalledTimes(4);
    } finally {
      controller.hostDisconnected();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  },
);

it.each([
  { duration: 1_000, requestsPerMinute: 10 },
  { duration: 2_000, requestsPerMinute: 7 },
])(
  "paces continuous Activity invalidations after $duration ms reads settle",
  async ({ duration, requestsPerMinute }) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.setSystemTime(0);
    const result = {
      ts: 1,
      path: "",
      count: 0,
      sessions: [],
      defaults: { model: null, modelProvider: null, contextTokens: null },
    };
    const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
    const starts: number[] = [];
    vi.spyOn(client, "request")
      .mockResolvedValueOnce(result)
      .mockImplementation(async () => {
        starts.push(Date.now());
        await new Promise<void>((resolve) => {
          setTimeout(resolve, duration);
        });
        return result;
      });
    const controller = new SessionActivityController({
      addController() {},
      removeController() {},
      requestUpdate() {},
      updateComplete: Promise.resolve(true),
    });
    try {
      void controller.load(client, { personId: null, time: "all", query: "" });
      await vi.advanceTimersByTimeAsync(0);
      for (let event = 0; event < 600; event += 1) {
        controller.invalidate();
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(starts).toHaveLength(requestsPerMinute);
      expect(starts[0]).toBe(5_000);
      expect(starts.slice(1).map((start, index) => start - starts[index]!)).toEqual(
        Array.from(
          { length: requestsPerMinute - 1 },
          () => duration + Math.max(5_000, 3 * duration),
        ),
      );
    } finally {
      controller.hostDisconnected();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  },
);

it.each([
  { action: "retry", phase: "pending" },
  { action: "retry", phase: "cooldown" },
  { action: "filter", phase: "pending" },
  { action: "filter", phase: "cooldown" },
])("bypasses automatic Activity $phase for an explicit $action", async ({ action, phase }) => {
  vi.useFakeTimers();
  const result = {
    ts: 1,
    path: "",
    count: 0,
    sessions: [],
    defaults: { model: null, modelProvider: null, contextTokens: null },
  };
  const replacement = { ...result, ts: 2 };
  const stale = createDeferred<typeof result>();
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const request = vi
    .spyOn(client, "request")
    .mockResolvedValueOnce(result)
    .mockReturnValueOnce(stale.promise)
    .mockResolvedValue(replacement);
  const controller = new SessionActivityController({
    addController() {},
    removeController() {},
    requestUpdate() {},
    updateComplete: Promise.resolve(true),
  });
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
    controller.hostDisconnected();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

it("keeps the same-query snapshot during invalidation and clears it on person changes", async () => {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const result = {
    ts: 1,
    path: "",
    count: 0,
    sessions: [],
    defaults: { model: null, modelProvider: null, contextTokens: null },
    involvingProfileId: "current",
  };
  const request = vi.spyOn(client, "request").mockResolvedValue(result);
  const controller = new SessionActivityController({
    addController() {},
    removeController() {},
    requestUpdate() {},
    updateComplete: Promise.resolve(true),
  });
  const filters = { personId: "former", time: "all" as const, query: "" };
  void controller.load(client, filters);
  await vi.waitFor(() => expect(controller.result).toEqual(result));
  void controller.load(client, filters, "refresh");
  expect(controller.result).toEqual(result);
  expect(request).toHaveBeenLastCalledWith(
    "sessions.list",
    expect.objectContaining({
      involvingProfileId: "former",
      includePeople: true,
      sortBy: "activity",
    }),
    expect.anything(),
  );
  void controller.load(client, { ...filters, personId: "other" });
  expect(controller.result).toBeUndefined();
  controller.hostDisconnected();
});

it("holds a trailing Activity refresh through page hiding and retires it on disconnect", async () => {
  vi.useFakeTimers();
  const documentEvents = new EventTarget();
  const pageEvents = new EventTarget();
  let visibilityState = "visible";
  Object.defineProperty(documentEvents, "visibilityState", { get: () => visibilityState });
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("addEventListener", pageEvents.addEventListener.bind(pageEvents));
  vi.stubGlobal("removeEventListener", pageEvents.removeEventListener.bind(pageEvents));
  const result = {
    ts: 1,
    path: "",
    count: 0,
    sessions: [],
    defaults: { model: null, modelProvider: null, contextTokens: null },
  };
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  let complete!: (value: typeof result) => void;
  const pending = new Promise<typeof result>((resolve) => {
    complete = resolve;
  });
  const request = vi.spyOn(client, "request").mockResolvedValue(result);
  const controller = new SessionActivityController({
    addController() {},
    removeController() {},
    requestUpdate() {},
    updateComplete: Promise.resolve(true),
  });
  try {
    controller.hostConnected();
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
    controller.hostDisconnected();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(3);
  } finally {
    complete(result);
    controller.hostDisconnected();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
