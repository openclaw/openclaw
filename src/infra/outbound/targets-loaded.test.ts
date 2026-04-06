import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { tryResolveLoadedOutboundTarget } from "./targets-loaded.js";

const mocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
  getActivePluginRegistry: vi.fn(),
  getActivePluginChannelRegistry: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: mocks.getActivePluginRegistry,
  getActivePluginChannelRegistry: mocks.getActivePluginChannelRegistry,
}));

describe("tryResolveLoadedOutboundTarget", () => {
  beforeEach(() => {
    mocks.getChannelPlugin.mockReset();
    mocks.getActivePluginRegistry.mockReset();
    mocks.getActivePluginChannelRegistry.mockReset();
  });

  it("returns undefined when no loaded plugin exists", () => {
    mocks.getChannelPlugin.mockReturnValue(undefined);
    mocks.getActivePluginRegistry.mockReturnValue(null);

    expect(tryResolveLoadedOutboundTarget({ channel: "telegram", to: "123" })).toBeUndefined();
  });

  it("uses loaded plugin config defaultTo fallback", () => {
    const cfg: OpenClawConfig = {
      channels: { telegram: { defaultTo: "123456789" } },
    };
    mocks.getChannelPlugin.mockReturnValue({
      id: "telegram",
      meta: { label: "Telegram" },
      capabilities: {},
      config: {
        resolveDefaultTo: ({ cfg }: { cfg: OpenClawConfig }) => cfg.channels?.telegram?.defaultTo,
      },
      outbound: {},
      messaging: {},
    });

    expect(
      tryResolveLoadedOutboundTarget({
        channel: "telegram",
        to: "",
        cfg,
        mode: "implicit",
      }),
    ).toEqual({ ok: true, to: "123456789" });
  });
});
