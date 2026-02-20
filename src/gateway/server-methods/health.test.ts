import { beforeEach, describe, expect, it, vi } from "vitest";
import { __setHealthBackgroundRefreshMinIntervalMsForTest } from "../server-constants.js";
import { __resetHealthBackgroundRefreshStateForTest, healthHandlers } from "./health.js";

describe("healthHandlers.health", () => {
  beforeEach(() => {
    __setHealthBackgroundRefreshMinIntervalMsForTest(5_000);
    __resetHealthBackgroundRefreshStateForTest();
  });

  it("coalesces cached background refreshes during burst requests", async () => {
    const respond = vi.fn();
    const refreshHealthSnapshot = vi.fn().mockResolvedValue({ ts: Date.now() });
    const getHealthCache = vi.fn().mockReturnValue({ ts: Date.now() });
    const logHealth = { error: vi.fn() };

    await healthHandlers.health({
      req: {} as never,
      params: {} as never,
      respond: respond as never,
      context: {
        getHealthCache,
        refreshHealthSnapshot,
        logHealth,
      } as never,
      client: null,
      isWebchatConnect: () => false,
    });
    await healthHandlers.health({
      req: {} as never,
      params: {} as never,
      respond: respond as never,
      context: {
        getHealthCache,
        refreshHealthSnapshot,
        logHealth,
      } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(refreshHealthSnapshot).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(2);
  });

  it("does not start a second background refresh while one is in-flight", async () => {
    __setHealthBackgroundRefreshMinIntervalMsForTest(0);

    const respond = vi.fn();
    const refreshHealthSnapshot = vi.fn().mockImplementation(
      () =>
        new Promise(() => {
          // Keep refresh unresolved to simulate a long-running probe.
        }),
    );
    const getHealthCache = vi.fn().mockReturnValue({ ts: Date.now() });
    const logHealth = { error: vi.fn() };

    await healthHandlers.health({
      req: {} as never,
      params: {} as never,
      respond: respond as never,
      context: {
        getHealthCache,
        refreshHealthSnapshot,
        logHealth,
      } as never,
      client: null,
      isWebchatConnect: () => false,
    });
    await healthHandlers.health({
      req: {} as never,
      params: {} as never,
      respond: respond as never,
      context: {
        getHealthCache,
        refreshHealthSnapshot,
        logHealth,
      } as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(refreshHealthSnapshot).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(2);
  });
});
