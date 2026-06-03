import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(),
}));

vi.mock("./registry.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
}));

import { runChannelPluginStartupMaintenance } from "./lifecycle-startup.js";

describe("runChannelPluginStartupMaintenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("continues startup maintenance after unreadable channel plugin lifecycle metadata", async () => {
    const warn = vi.fn();
    const healthyMaintenance = vi.fn();
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "broken-channel",
        get lifecycle() {
          throw new Error("channel lifecycle getter exploded");
        },
      },
      {
        id: "healthy-channel",
        lifecycle: {
          runStartupMaintenance: healthyMaintenance,
        },
      },
    ]);

    await runChannelPluginStartupMaintenance({
      cfg: {},
      log: { warn },
    });

    expect(healthyMaintenance).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "gateway: broken-channel startup maintenance failed; continuing: Error: channel lifecycle getter exploded",
    );
  });

  it("keeps startup maintenance failure logging best-effort when plugin id is unreadable", async () => {
    const warn = vi.fn();
    mocks.listChannelPlugins.mockReturnValue([
      {
        get id() {
          throw new Error("channel id getter exploded");
        },
        lifecycle: {
          runStartupMaintenance: () => {
            throw new Error("startup maintenance exploded");
          },
        },
      },
    ]);

    await runChannelPluginStartupMaintenance({
      cfg: {},
      log: { warn },
    });

    expect(warn).toHaveBeenCalledWith(
      "gateway: unknown startup maintenance failed; continuing: Error: startup maintenance exploded",
    );
  });
});
