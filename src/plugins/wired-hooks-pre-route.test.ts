import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";

const preRouteEvent = {
  from: "discord:user:alice",
  content: "hello",
  channel: "discord",
  accountId: "default",
  conversationId: "channel:1",
  senderId: "alice",
  isGroup: true,
};

const preRouteCtx = {
  channelId: "discord",
  accountId: "default",
  conversationId: "channel:1",
  senderId: "alice",
  sessionKey: "agent:main:discord:group:channel:1",
};

describe("pre_route hook runner", () => {
  it("stops at the first handler that returns handled=true", async () => {
    const first = vi.fn().mockResolvedValue({
      handled: true,
      routeOverride: {
        sessionKey: "agent:isolated:discord:group:channel:1",
      },
    });
    const second = vi.fn().mockResolvedValue({ handled: true });
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "pre_route", handler: first },
      { hookName: "pre_route", handler: second },
    ]);

    const result = await runner.runPreRoute(preRouteEvent, preRouteCtx);

    expect(result).toEqual({
      handled: true,
      routeOverride: {
        sessionKey: "agent:isolated:discord:group:channel:1",
      },
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("continues when a handler throws and a later one handles", async () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const succeeding = vi.fn().mockResolvedValue({ handled: true });
    const { runner } = createHookRunnerWithRegistry(
      [
        { hookName: "pre_route", handler: failing },
        { hookName: "pre_route", handler: succeeding },
      ],
      { logger },
    );

    const result = await runner.runPreRoute(preRouteEvent, preRouteCtx);

    expect(result).toEqual({ handled: true });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("pre_route handler from test-plugin failed: Error: boom"),
    );
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it("passes AbortSignal to pre_route handlers", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const { runner } = createHookRunnerWithRegistry([{ hookName: "pre_route", handler }]);
    const controller = new AbortController();

    await runner.runPreRoute(preRouteEvent, preRouteCtx, controller.signal);

    expect(handler).toHaveBeenCalledWith(preRouteEvent, preRouteCtx, controller.signal);
  });

  it("skips handlers when signal is already aborted", async () => {
    const handler = vi.fn().mockResolvedValue({ handled: true });
    const { runner } = createHookRunnerWithRegistry([{ hookName: "pre_route", handler }]);
    const controller = new AbortController();
    controller.abort();

    const result = await runner.runPreRoute(preRouteEvent, preRouteCtx, controller.signal);

    expect(result).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });
});
