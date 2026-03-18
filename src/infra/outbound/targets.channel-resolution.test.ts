import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
}));

const TEST_WORKSPACE_ROOT = "/tmp/openclaw-test-workspace";

function normalizeChannel(value?: string) {
  return value?.trim().toLowerCase() ?? undefined;
}

function applyPluginAutoEnableForTests(config: unknown) {
  return { config, changes: [] as unknown[] };
}

function createTelegramPlugin() {
  return {
    id: "telegram",
    meta: { label: "Telegram" },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
  };
}

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: normalizeChannel,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => TEST_WORKSPACE_ROOT,
}));

vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: mocks.loadOpenClawPlugins,
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable(args: { config: unknown }) {
    return applyPluginAutoEnableForTests(args.config);
  },
}));

import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

let resolveOutboundTarget: typeof import("./targets.js").resolveOutboundTarget;

describe("resolveOutboundTarget channel resolution", () => {
  let registrySeq = 0;
  const resolveTelegramTarget = () =>
    resolveOutboundTarget({
      channel: "telegram",
      to: "123456",
      cfg: { channels: { telegram: { botToken: "test-token" } } },
      mode: "explicit",
    });

  beforeEach(async () => {
    vi.resetModules();
    ({ resolveOutboundTarget } = await import("./targets.js"));
    registrySeq += 1;
    setActivePluginRegistry(createTestRegistry([]), `targets-test-${registrySeq}`);
    mocks.getChannelPlugin.mockReset();
    mocks.loadOpenClawPlugins.mockReset();
  });

  it("recovers telegram plugin resolution so announce delivery does not fail with Unsupported channel: telegram", () => {
    const telegramPlugin = createTelegramPlugin();
    mocks.getChannelPlugin
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(telegramPlugin)
      .mockReturnValue(telegramPlugin);

    const result = resolveTelegramTarget();

    expect(result).toEqual({ ok: true, to: "123456" });
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
  });

  it("retries bootstrap on subsequent resolve when the first bootstrap attempt fails", () => {
    const telegramPlugin = createTelegramPlugin();
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

    const first = resolveTelegramTarget();
    const second = resolveTelegramTarget();

    expect(first.ok).toBe(false);
    expect(second).toEqual({ ok: true, to: "123456" });
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(2);
  });
});
