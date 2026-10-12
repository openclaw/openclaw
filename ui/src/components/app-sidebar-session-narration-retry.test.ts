import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @vitest-environment node
import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
} from "../../../packages/gateway-client/src/protocol-request.js";
import { GatewaySessionMessageSubscriptionCoordinator } from "../../../packages/gateway-client/src/session-subscriptions.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  browserVisibility,
  createRunningNarrationController,
  runningRow,
} from "../test-helpers/app-sidebar-session-narration.ts";
import {
  SidebarSessionNarrationController,
  type SidebarNarrationSyncInput,
} from "./app-sidebar-session-narration.ts";

function releaseFixture(
  failure: Error | null = new GatewayProtocolRequestError({ retryable: true }),
) {
  const server = { failure };
  const wireKeys = new Set<string>();
  const request = vi
    .fn()
    .mockImplementation(async (method: string, params: Record<string, unknown>) => {
      const key = String(params.key);
      if (method === "sessions.messages.subscribe") {
        wireKeys.add(key);
      } else {
        if (server.failure) {
          throw server.failure;
        }
        wireKeys.delete(key);
      }
      return { key };
    });
  const coordinator = new GatewaySessionMessageSubscriptionCoordinator({ request });
  const source = {
    subscribeMessages: (key: string, options?: Parameters<typeof coordinator.acquire>[1]) =>
      coordinator.acquire(key, options),
    unsubscribeMessages: vi.fn((handle: Awaited<ReturnType<typeof coordinator.acquire>>) =>
      coordinator.release(handle),
    ),
  };
  return {
    ...createRunningNarrationController(source),
    source,
    server,
    wireKeys,
    request,
    coordinator,
  };
}

describe("sidebar narration subscription retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("paces failed releases across syncs and releases the original lease after recovery", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { controller, input, source, server, wireKeys } = releaseFixture();
    await vi.advanceTimersByTimeAsync(0);
    const removed = { ...input, rows: [] };
    for (let index = 0; index < 100; index++) {
      controller.sync(removed);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(source.unsubscribeMessages).toHaveBeenCalledOnce();
    expect(wireKeys.size).toBe(1);
    const original = source.unsubscribeMessages.mock.calls[0]?.[0];
    for (const delay of [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
      const attempts = source.unsubscribeMessages.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      controller.sync(removed);
      expect(source.unsubscribeMessages).toHaveBeenCalledTimes(attempts);
      await vi.advanceTimersByTimeAsync(1);
      expect(source.unsubscribeMessages).toHaveBeenCalledTimes(attempts + 1);
    }
    server.failure = null;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(source.unsubscribeMessages.mock.calls.every(([handle]) => handle === original)).toBe(
      true,
    );
    expect(wireKeys.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    controller.disconnect();
  });

  it("jitters a release after the server hint", async () => {
    const draw = 0.5;
    vi.spyOn(Math, "random").mockReturnValue(draw);
    const { controller, input, source, server, wireKeys } = releaseFixture(
      new GatewayProtocolRequestError({ retryable: true, retryAfterMs: 90_000 }),
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.sync({ ...input, rows: [] });
    await vi.advanceTimersByTimeAsync(0);
    server.failure = null;
    await vi.advanceTimersByTimeAsync(90_000 + draw * 500 - 1);
    expect(source.unsubscribeMessages).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(wireKeys.size).toBe(0);
    expect(source.unsubscribeMessages).toHaveBeenCalledTimes(2);
    controller.disconnect();
  });

  it.each([
    { retryable: false, returning: false },
    { retryable: undefined, returning: false },
    { retryable: false, returning: true },
  ])(
    "does not retry terminal release rejection (retryable=$retryable, returning=$returning)",
    async ({ retryable, returning }) => {
      const failure = new GatewayProtocolRequestError({ retryable });
      const { controller, input, source, request } = releaseFixture(failure);
      await vi.advanceTimersByTimeAsync(0);
      const rejected = createDeferred();
      if (returning) {
        request.mockImplementationOnce(async () => {
          await rejected.promise;
          throw failure;
        });
      }
      const removed = { ...input, rows: [] };
      controller.sync(removed);
      if (returning) {
        controller.sync(input);
        controller.sync(removed);
        rejected.resolve();
      } else {
        await vi.advanceTimersByTimeAsync(0);
        controller.sync(removed);
      }
      await vi.advanceTimersByTimeAsync(60_000);
      if (returning) {
        expect(request).toHaveBeenCalledTimes(2);
      } else {
        expect(source.unsubscribeMessages).toHaveBeenCalledOnce();
      }
      expect(vi.getTimerCount()).toBe(0);
      controller.disconnect();
    },
  );

  it("cancels a queued release when re-desired and preserves shared viewers", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { controller, input, request, wireKeys, coordinator, server } = releaseFixture();
    await vi.advanceTimersByTimeAsync(0);
    controller.sync({ ...input, rows: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2);
    controller.sync(input);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(wireKeys.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    const key = input.rows[0]!.key;
    const pane = await coordinator.acquire(key);
    controller.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      [
        "sessions.messages.subscribe",
        { key, mode: "narration", subscriptionId: expect.any(String) },
      ],
      ["sessions.messages.unsubscribe", { key, subscriptionId: expect.any(String) }],
      ["sessions.messages.subscribe", { key, subscriptionId: expect.any(String) }],
    ]);
    expect(wireKeys.has(key)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    server.failure = null;
    await coordinator.release(pane);
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      "sessions.messages.unsubscribe",
      { key, subscriptionId: expect.any(String) },
    ]);
    expect(wireKeys.size).toBe(0);
  });

  it("resumes cleanup when re-acquisition fails and interest leaves again", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { controller, input, source, server, wireKeys } = releaseFixture();
    await vi.advanceTimersByTimeAsync(0);
    controller.sync({ ...input, rows: [] });
    await vi.advanceTimersByTimeAsync(0);
    vi.spyOn(source, "subscribeMessages").mockRejectedValue(
      new GatewayProtocolRequestError({ retryable: true }),
    );
    controller.sync(input);
    await vi.advanceTimersByTimeAsync(0);
    server.failure = null;
    controller.sync({ ...input, rows: [] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wireKeys.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    controller.disconnect();
  });

  it.each([false, true])(
    "settles a re-desired in-flight release without losing its observer (timeout: %s)",
    async (timedOut) => {
      const { controller, input, request, server, wireKeys } = releaseFixture();
      await vi.advanceTimersByTimeAsync(0);
      const released = createDeferred();
      request.mockImplementationOnce(async () => {
        await released.promise;
        if (timedOut) {
          wireKeys.clear();
          throw new GatewayProtocolRequestTimeoutError({
            method: "sessions.messages.unsubscribe",
            timeoutMs: 30_000,
            requestSent: true,
          });
        }
        throw new GatewayProtocolRequestError({ retryable: true });
      });
      controller.sync({ ...input, rows: [] });
      controller.sync(input);
      released.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(wireKeys.size).toBe(1);
      expect(request).toHaveBeenCalledTimes(timedOut ? 3 : 2);
      expect(vi.getTimerCount()).toBe(0);
      server.failure = null;
      controller.disconnect();
      await vi.advanceTimersByTimeAsync(0);
      expect(wireKeys.size).toBe(0);
    },
  );

  it.each(["close", "replace", "disconnect"])(
    "cancels release retry work on %s",
    async (change) => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const { controller, input, source, coordinator } = releaseFixture();
      await vi.advanceTimersByTimeAsync(0);
      controller.sync({ ...input, rows: [] });
      await vi.advanceTimersByTimeAsync(0);
      if (change === "disconnect") {
        controller.disconnect();
      } else {
        coordinator.reset();
        controller.sync({
          ...input,
          rows: [],
          connected: change !== "close",
          connectionIdentity: change === "replace" ? {} : input.connectionIdentity,
        });
      }
      expect(vi.getTimerCount()).toBe(0);
      const attempts = source.unsubscribeMessages.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(source.unsubscribeMessages).toHaveBeenCalledTimes(attempts);
      controller.disconnect();
    },
  );

  it("coalesces an overdue release retry with the next sidebar sync", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { controller, input, source, server, wireKeys } = releaseFixture();
    await vi.advanceTimersByTimeAsync(0);
    const removed = { ...input, rows: [] };
    controller.sync(removed);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 250);
    server.failure = null;
    controller.sync(removed);
    controller.sync(removed);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(source.unsubscribeMessages).toHaveBeenCalledTimes(2);
    expect(wireKeys.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    controller.disconnect();
  });

  it.each([false, true])(
    "retains failed cleanup across DOM detachment (re-desired: %s)",
    async (desired) => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const { controller, input, server, wireKeys } = releaseFixture();
      await vi.advanceTimersByTimeAsync(0);
      const removed = { ...input, rows: [] };
      controller.sync(removed);
      await vi.advanceTimersByTimeAsync(0);
      controller.disconnect();
      expect(vi.getTimerCount()).toBe(0);
      server.failure = null;
      controller.sync(desired ? input : removed);
      await vi.advanceTimersByTimeAsync(0);
      expect(wireKeys.size).toBe(desired ? 1 : 0);
      controller.disconnect();
      await vi.advanceTimersByTimeAsync(0);
      expect(wireKeys.size).toBe(0);
    },
  );

  it("paces failed acquisitions across render syncs and converges without another render", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let busy = true;
    const wireKeys = new Set<string>();
    const request = vi.fn().mockImplementation(async (method: string, params: { key: string }) => {
      if (method === "sessions.messages.subscribe") {
        if (busy) {
          throw new GatewayProtocolRequestError({ code: "UNAVAILABLE", retryable: true });
        }
        wireKeys.add(params.key);
      } else {
        wireKeys.delete(params.key);
      }
      return { key: params.key };
    });
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator({ request });
    const input: SidebarNarrationSyncInput = {
      enabled: true,
      connected: true,
      connectionIdentity: coordinator,
      source: {
        subscribeMessages: (key, options) => coordinator.acquire(key, options),
        unsubscribeMessages: (handle) => coordinator.release(handle),
      },
      rows: Array.from({ length: 8 }, (_, index) => ({
        ...runningRow(`agent:main:run-${index}`),
        startedAt: undefined,
        updatedAt: index,
      })),
      openSessionKey: "",
      agentId: "main",
    };
    const controller = new SidebarSessionNarrationController(() => undefined);
    controller.sync(input);
    for (let index = 0; index < 100; index++) {
      await vi.advanceTimersByTimeAsync(0);
      input.rows[0]!.updatedAt = index + 10;
      controller.sync(input);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(6);

    for (const delay of [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
      const attempts = request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      controller.sync(input);
      expect(request).toHaveBeenCalledTimes(attempts);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(attempts + 6);
    }
    busy = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect([...wireKeys].toSorted()).toEqual(
      Array.from({ length: 6 }, (_, index) => `agent:main:run-${index + 2}`),
    );
    expect(vi.getTimerCount()).toBe(0);
    controller.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(wireKeys.size).toBe(0);
  });

  it("reacquires after the coordinator compensates a sent request timeout", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayProtocolRequestTimeoutError({
          method: "sessions.messages.subscribe",
          timeoutMs: 30_000,
          requestSent: true,
        }),
      )
      .mockResolvedValue({ key: "agent:main:run" });
    const coordinator = new GatewaySessionMessageSubscriptionCoordinator({ request });
    const subscribeMessages = vi.fn(coordinator.acquire.bind(coordinator));
    const { controller } = createRunningNarrationController({
      subscribeMessages,
      unsubscribeMessages: (handle) => coordinator.release(handle),
    });
    await expect(subscribeMessages.mock.results[0]?.value).rejects.toBeInstanceOf(
      GatewayProtocolRequestTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "sessions.messages.subscribe",
      "sessions.messages.unsubscribe",
    ]);
    await vi.advanceTimersByTimeAsync(250);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "sessions.messages.subscribe",
      "sessions.messages.unsubscribe",
      "sessions.messages.subscribe",
    ]);
    expect(vi.getTimerCount()).toBe(0);
    controller.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it.each<{ draw: number; hint?: number; delay: number; clockShift?: number }>([
    { draw: 0, hint: undefined, delay: 1 },
    { draw: 0.9, hint: undefined, delay: 450 },
    { draw: 0.5, hint: 90_000, delay: 90_250 },
    { draw: 0.5, hint: Number.MAX_VALUE, delay: 2_147_483_647 },
    { draw: 0.5, delay: 250, clockShift: -5_000 },
  ])(
    "honors full jitter and the server retry floor: %j",
    async ({ draw, hint, delay, clockShift }) => {
      vi.spyOn(Math, "random").mockReturnValue(draw);
      const source = {
        subscribeMessages: vi
          .fn()
          .mockRejectedValueOnce(
            new GatewayProtocolRequestError({ retryable: true, retryAfterMs: hint }),
          )
          .mockResolvedValue({ key: "agent:main:run", agentId: null }),
        unsubscribeMessages: vi.fn().mockResolvedValue(undefined),
      };
      const { controller } = createRunningNarrationController(source);
      await vi.advanceTimersByTimeAsync(0);
      if (clockShift) {
        vi.setSystemTime(Date.now() + clockShift);
      }
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(source.subscribeMessages).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(source.subscribeMessages).toHaveBeenCalledTimes(2);
      controller.disconnect();
    },
  );

  it.each([false, undefined])("does not retry a rejection with retryable=%s", async (retryable) => {
    const source = {
      subscribeMessages: vi
        .fn()
        .mockRejectedValue(new GatewayProtocolRequestError({ code: "FORBIDDEN", retryable })),
      unsubscribeMessages: vi.fn().mockResolvedValue(undefined),
    };
    const visibility = browserVisibility();
    const { controller } = createRunningNarrationController(source);
    await vi.advanceTimersByTimeAsync(0);
    visibility("visible");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(source.subscribeMessages).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    visibility("hidden");
    visibility("visible");
    expect(source.subscribeMessages).toHaveBeenCalledTimes(2);
    controller.disconnect();
  });

  it("coalesces an overdue retry with a sync and shares the in-flight attempt", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const ready = createDeferred<{ key: string; agentId: null }>();
    const source = {
      subscribeMessages: vi
        .fn()
        .mockRejectedValueOnce(new GatewayProtocolRequestError({ retryable: true }))
        .mockReturnValueOnce(ready.promise),
      unsubscribeMessages: vi.fn().mockResolvedValue(undefined),
    };
    const visibility = browserVisibility();
    const { controller } = createRunningNarrationController(source);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 250);
    visibility("visible");
    visibility("visible");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(source.subscribeMessages).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    ready.resolve({ key: "agent:main:run", agentId: null });
    await ready.promise;
    visibility("visible");
    expect(source.subscribeMessages).toHaveBeenCalledTimes(2);
    controller.disconnect();
  });

  it.each(["rows", "agent", "source", "connection", "hidden", "disabled", "disconnect"])(
    "cancels retry work when %s changes and ignores late failures",
    async (change) => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const visibility = browserVisibility();
      const failure = new GatewayProtocolRequestError({ retryable: true });
      const late = createDeferred<{ key: string; agentId: null }>();
      const source = {
        subscribeMessages: vi
          .fn()
          .mockRejectedValueOnce(failure)
          .mockReturnValueOnce(late.promise)
          .mockImplementation(async (key: string, options?: { agentId?: string }) => ({
            key,
            agentId: options?.agentId ?? null,
          })),
        unsubscribeMessages: vi.fn().mockResolvedValue(undefined),
      };
      const controller = new SidebarSessionNarrationController(() => undefined);
      const input: SidebarNarrationSyncInput = {
        enabled: true,
        connected: true,
        connectionIdentity: {},
        source,
        rows: [runningRow("global"), runningRow("agent:main:late")],
        openSessionKey: "",
        agentId: "main",
      };
      controller.sync(input);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      switch (change) {
        case "rows":
          controller.sync({ ...input, rows: [] });
          break;
        case "agent":
          controller.sync({ ...input, agentId: "research", rows: [runningRow("global")] });
          break;
        case "source":
          controller.sync({ ...input, source: { ...source } });
          break;
        case "connection":
          controller.sync({ ...input, connected: false });
          break;
        case "hidden":
          visibility("hidden");
          break;
        case "disabled":
          controller.sync({ ...input, enabled: false });
          break;
        case "disconnect":
          controller.disconnect();
          break;
      }
      late.reject(failure);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      const attempts = source.subscribeMessages.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(source.subscribeMessages).toHaveBeenCalledTimes(attempts);
      controller.disconnect();
    },
  );
});
