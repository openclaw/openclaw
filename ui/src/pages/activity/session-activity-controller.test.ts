// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { SessionActivityController } from "./session-activity-controller.ts";

it.each([
  { duration: 1_000, requestsPerMinute: 10 },
  { duration: 2_000, requestsPerMinute: 7 },
])(
  "paces continuous Activity invalidations after $duration ms reads settle",
  async ({ duration, requestsPerMinute }) => {
    vi.useFakeTimers();
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
