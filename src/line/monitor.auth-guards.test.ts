import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { monitorLineProvider } from "./monitor.js";

const createLineBotMock = vi.fn();

vi.mock("./bot.js", () => ({
  createLineBot: (...args: unknown[]) => createLineBotMock(...args),
}));

describe("monitorLineProvider auth guards", () => {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;

  const cfg = {} as OpenClawConfig;

  it("fails closed when channel secret is empty", async () => {
    await expect(
      monitorLineProvider({
        channelAccessToken: "line-token",
        channelSecret: "   ",
        accountId: "default",
        config: cfg,
        runtime,
      }),
    ).rejects.toThrow(/channel secret missing/i);

    expect(createLineBotMock).not.toHaveBeenCalled();
  });

  it("fails closed when channel access token is empty", async () => {
    await expect(
      monitorLineProvider({
        channelAccessToken: " ",
        channelSecret: "line-secret",
        accountId: "default",
        config: cfg,
        runtime,
      }),
    ).rejects.toThrow(/access token missing/i);

    expect(createLineBotMock).not.toHaveBeenCalled();
  });
});
