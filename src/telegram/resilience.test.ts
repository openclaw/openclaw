import { describe, it, expect, vi } from "vitest";
import { Circuit, State } from "./circuit.js";
import { BotHealthCheck } from "./health.js";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("health", () => {
  it("checks bot status", async () => {
    const getMe = vi.fn().mockResolvedValue({ id: 1 });
    const bot = { api: { getMe } } as never;
    const check = new BotHealthCheck(bot, logger as never);

    const result = await check.check();
    expect(result.ok).toBe(true);
    expect(getMe).toHaveBeenCalled();
  });

  it("tracks failures", async () => {
    const getMe = vi.fn().mockRejectedValue(new Error("api error"));
    const bot = { api: { getMe } } as never;
    const onFail = vi.fn();
    const check = new BotHealthCheck(bot, logger, { failureThreshold: 2, onFail });

    await check.check();
    await check.check();

    expect(onFail).toHaveBeenCalled();
  });
});

describe("circuit", () => {
  it("starts closed", () => {
    const c = new Circuit(logger as never);
    expect(c.getState()).toBe(State.Closed);
  });

  it("opens on failures", async () => {
    const c = new Circuit(logger as never, { failures: 2 });
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    try {
      await c.exec(fn);
    } catch {}

    try {
      await c.exec(fn);
    } catch {}

    expect(c.getState()).toBe(State.Open);
  });

  it("rejects when open", async () => {
    const c = new Circuit(logger as never, { failures: 1 });
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    try {
      await c.exec(fn);
    } catch {}

    await expect(c.exec(async () => "ok")).rejects.toThrow("circuit open");
  });
});
