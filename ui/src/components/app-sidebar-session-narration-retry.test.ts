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
    const { controller } = createRunningNarrationController({
      subscribeMessages: (key, options) => coordinator.acquire(key, options),
      unsubscribeMessages: (handle) => coordinator.release(handle),
    });
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
