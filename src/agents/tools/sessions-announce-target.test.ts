import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

const loadResolveAnnounceTarget = async () => await import("./sessions-announce-target.js");

const installRegistry = async () => {
  const { setActivePluginRegistry } = await import("../../plugins/runtime.js");
  setActivePluginRegistry(
    createTestRegistry([
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
          capabilities: { chatTypes: ["direct", "channel", "thread"] },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
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
          capabilities: { chatTypes: ["direct", "group", "channel"] },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
      {
        pluginId: "whatsapp",
        source: "test",
        plugin: {
          id: "whatsapp",
          meta: {
            id: "whatsapp",
            label: "WhatsApp",
            selectionLabel: "WhatsApp",
            docsPath: "/channels/whatsapp",
            blurb: "WhatsApp test stub.",
            preferSessionLookupForAnnounceTarget: true,
          },
          capabilities: { chatTypes: ["direct", "group"] },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
    ]),
  );
};

describe("resolveAnnounceTarget", () => {
  beforeEach(async () => {
    callGatewayMock.mockReset();
    vi.resetModules();
    await installRegistry();
  });

  it("derives non-WhatsApp announce targets from the session key", async () => {
    const { resolveAnnounceTarget } = await loadResolveAnnounceTarget();
    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
    });
    expect(target).toEqual({ channel: "discord", to: "channel:dev" });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("hydrates WhatsApp accountId from sessions.list when available", async () => {
    const { resolveAnnounceTarget } = await loadResolveAnnounceTarget();
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:whatsapp:group:123@g.us",
          deliveryContext: {
            channel: "whatsapp",
            to: "123@g.us",
            accountId: "work",
          },
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      displayKey: "agent:main:whatsapp:group:123@g.us",
    });
    expect(target).toEqual({
      channel: "whatsapp",
      to: "123@g.us",
      accountId: "work",
    });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const first = callGatewayMock.mock.calls[0]?.[0] as { method?: string } | undefined;
    expect(first).toBeDefined();
    expect(first?.method).toBe("sessions.list");
  });

  it("skips webchat (internal) channel from sessions.list and falls back to requesterSessionKey", async () => {
    const { resolveAnnounceTarget } = await loadResolveAnnounceTarget();
    // sessions.list returns webchat as lastChannel for agent:yuri:main
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:yuri:main",
          lastChannel: "webchat",
          lastTo: "agent:yuri:main",
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:yuri:main",
      displayKey: "agent:yuri:main",
      requesterSessionKey: "agent:sena:telegram:group:-1003708523054",
    });
    // Should resolve to telegram group from requesterSessionKey, not webchat
    expect(target).toBeTruthy();
    expect(target?.channel).toBe("telegram");
    expect(target?.to).toContain("-1003708523054");
  });

  it("skips webchat deliveryContext and falls back to requesterSessionKey", async () => {
    const { resolveAnnounceTarget } = await loadResolveAnnounceTarget();
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:yuri:main",
          deliveryContext: {
            channel: "webchat",
            to: "agent:yuri:main",
          },
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:yuri:main",
      displayKey: "agent:yuri:main",
      requesterSessionKey: "agent:sena:telegram:group:-1003708523054",
    });
    expect(target?.channel).toBe("telegram");
    expect(target?.to).toContain("-1003708523054");
  });

  it("returns null when sessions.list has webchat and no requesterSessionKey", async () => {
    const { resolveAnnounceTarget } = await loadResolveAnnounceTarget();
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:yuri:main",
          lastChannel: "webchat",
          lastTo: "agent:yuri:main",
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:yuri:main",
      displayKey: "agent:yuri:main",
      // no requesterSessionKey
    });
    expect(target).toBeNull();
  });
});
