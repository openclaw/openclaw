import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
  resolveOutboundTarget: vi.fn(),
  deliverOutboundPayloads: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
  extractDeliveryInfo: vi.fn(() => ({ deliveryContext: undefined, threadId: undefined })),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  normalizeChannelId: (channel?: string) => channel?.trim().toLowerCase() ?? undefined,
  getChannelPlugin: mocks.getChannelPlugin,
  listChannelPlugins: () => [],
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
  resolveSessionAgentId: () => "main",
  resolveAgentWorkspaceDir: () => "/tmp/openclaw-test-workspace",
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: ({ config }: { config: unknown }) => ({ config, changes: [] }),
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    extractDeliveryInfo: (...args: unknown[]) =>
      (mocks.extractDeliveryInfo as (...args: unknown[]) => unknown)(...args),
  };
});

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
    mocks.extractDeliveryInfo.mockClear();
    mocks.extractDeliveryInfo.mockReturnValue({ deliveryContext: undefined, threadId: undefined });

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

  it("uses mirror session deliveryContext channel as fallback in multi-channel mode", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            id: "telegram",
            meta: {
              id: "telegram",
              label: "Telegram",
              selectionLabel: "Telegram",
              docsPath: "/channels/telegram",
              blurb: "Telegram test stub.",
            },
            capabilities: { chatTypes: ["direct"] },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({}),
              isConfigured: async () => true,
            },
            outbound: { deliveryMode: "direct" },
          },
        },
        {
          pluginId: "discord",
          source: "test",
          plugin: {
            id: "discord",
            meta: {
              id: "discord",
              label: "Discord",
              selectionLabel: "Discord",
              docsPath: "/channels/discord",
              blurb: "Discord test stub.",
            },
            capabilities: { chatTypes: ["direct"] },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({}),
              isConfigured: async () => true,
            },
            outbound: { deliveryMode: "direct" },
          },
        },
      ]),
    );
    mocks.extractDeliveryInfo.mockReturnValue({
      deliveryContext: { channel: "telegram", to: "123456" },
      threadId: undefined,
    });

    await sendMessage({
      cfg: {},
      to: "123456",
      content: "hi",
      mirror: { sessionKey: "agent:main:main" },
    });

    expect(mocks.extractDeliveryInfo).toHaveBeenCalledWith("agent:main:main");
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", to: "123456" }),
    );
  });
});
