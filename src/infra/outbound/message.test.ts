import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
  resolveOutboundTarget: vi.fn(),
  deliverOutboundPayloads: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  normalizeChannelId: (channel?: string) => channel?.trim().toLowerCase() ?? undefined,
  getChannelPlugin: mocks.getChannelPlugin,
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

vi.mock("./targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

vi.mock("./deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { sendMessage } from "./message.js";

describe("sendMessage", () => {
  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    mocks.getChannelPlugin.mockClear();
    mocks.resolveOutboundTarget.mockClear();
    mocks.deliverOutboundPayloads.mockClear();
    mocks.loadOpenClawPlugins.mockClear();

    mocks.getChannelPlugin.mockReturnValue({
      outbound: { deliveryMode: "direct" },
    });
    mocks.resolveOutboundTarget.mockImplementation(({ to }: { to: string }) => ({ ok: true, to }));
    mocks.deliverOutboundPayloads.mockResolvedValue([{ channel: "mattermost", messageId: "m1" }]);
  });

  it("passes explicit agentId to outbound delivery for scoped media roots", async () => {
    await sendMessage({
      cfg: {},
      channel: "telegram",
      to: "123456",
      content: "hi",
      agentId: "work",
    });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ agentId: "work" }),
        channel: "telegram",
        to: "123456",
      }),
    );
  });

  it("recovers telegram plugin resolution so message/send does not fail with Unknown channel: telegram", async () => {
    const telegramPlugin = {
      outbound: { deliveryMode: "direct" },
    };
    mocks.getChannelPlugin
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(telegramPlugin)
      .mockReturnValue(telegramPlugin);

    await expect(
      sendMessage({
        cfg: { channels: { telegram: { botToken: "test-token" } } },
        channel: "telegram",
        to: "123456",
        content: "hi",
      }),
    ).resolves.toMatchObject({
      channel: "telegram",
      to: "123456",
      via: "direct",
    });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
  });
});
