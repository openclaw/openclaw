import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: (channel?: string) => channel?.trim().toLowerCase() ?? undefined,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => "/tmp/openclaw-test-workspace",
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: ({ config }: { config: unknown }) => ({ config, changes: [] }),
}));

vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: mocks.loadOpenClawPlugins,
}));

import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveOutboundTarget } from "./targets.js";

describe("resolveOutboundTarget channel resolution", () => {
  let registrySeq = 0;

  beforeEach(() => {
    registrySeq += 1;
    setActivePluginRegistry(createTestRegistry([]), `targets-test-${registrySeq}`);
    mocks.getChannelPlugin.mockReset();
    mocks.loadOpenClawPlugins.mockReset();
  });

  it("recovers telegram plugin resolution so announce delivery does not fail with Unsupported channel: telegram", () => {
    const telegramPlugin = {
      id: "telegram",
      meta: { label: "Telegram" },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
      },
    };
    mocks.getChannelPlugin
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(telegramPlugin)
      .mockReturnValue(telegramPlugin);

    const result = resolveOutboundTarget({
      channel: "telegram",
      to: "123456",
      cfg: { channels: { telegram: { botToken: "test-token" } } },
      mode: "explicit",
    });

    expect(result).toEqual({ ok: true, to: "123456" });
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
  });

  it("retries bootstrap on subsequent resolve when the first bootstrap attempt fails", () => {
    const telegramPlugin = {
      id: "telegram",
      meta: { label: "Telegram" },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
      },
    };
    mocks.getChannelPlugin
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(telegramPlugin)
      .mockReturnValue(telegramPlugin);
    mocks.loadOpenClawPlugins
      .mockImplementationOnce(() => {
        throw new Error("bootstrap failed");
      })
      .mockImplementation(() => undefined);

    const first = resolveOutboundTarget({
      channel: "telegram",
      to: "123456",
      cfg: { channels: { telegram: { botToken: "test-token" } } },
      mode: "explicit",
    });
    const second = resolveOutboundTarget({
      channel: "telegram",
      to: "123456",
      cfg: { channels: { telegram: { botToken: "test-token" } } },
      mode: "explicit",
    });

    expect(first.ok).toBe(false);
    expect(second).toEqual({ ok: true, to: "123456" });
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(2);
  });
});
