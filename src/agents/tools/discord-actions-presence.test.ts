import type { GatewayPlugin } from "@buape/carbon/gateway";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordActionConfig } from "../../config/config.js";
import { clearGateways, registerGateway } from "../../discord/monitor/gateway-registry.js";
import type { ActionGate } from "./common.js";
import { handleDiscordPresenceAction } from "./discord-actions-presence.js";

const mockUpdatePresence = vi.fn();

const discordSendMocks = vi.hoisted(() => ({
  fetchCurrentUserDiscord: vi.fn(async () => ({ id: "bot-1" })),
  updateCurrentUserAvatarDiscord: vi.fn(async () => ({ id: "bot-1" })),
  updateSelfNicknameDiscord: vi.fn(async () => ({ nick: "Bot" })),
}));

const { fetchCurrentUserDiscord, updateCurrentUserAvatarDiscord, updateSelfNicknameDiscord } =
  discordSendMocks;

vi.mock("../../discord/send.js", () => ({
  ...discordSendMocks,
}));

function createMockGateway(connected = true): GatewayPlugin {
  return { isConnected: connected, updatePresence: mockUpdatePresence } as unknown as GatewayPlugin;
}

const presenceEnabled: ActionGate<DiscordActionConfig> = (key) => key === "presence";
const selfProfileEnabled: ActionGate<DiscordActionConfig> = (key) => key === "selfProfile";
const presenceAndSelfProfileEnabled: ActionGate<DiscordActionConfig> = (key) =>
  key === "presence" || key === "selfProfile";
const presenceDisabled: ActionGate<DiscordActionConfig> = () => false;

describe("handleDiscordPresenceAction", () => {
  async function setPresence(
    params: Record<string, unknown>,
    actionGate: ActionGate<DiscordActionConfig> = presenceEnabled,
  ) {
    return await handleDiscordPresenceAction("setPresence", params, actionGate);
  }

  async function updateSelfProfile(
    params: Record<string, unknown>,
    actionGate: ActionGate<DiscordActionConfig> = selfProfileEnabled,
  ) {
    return await handleDiscordPresenceAction("updateSelfProfile", params, actionGate);
  }

  beforeEach(() => {
    mockUpdatePresence.mockClear();
    fetchCurrentUserDiscord.mockClear();
    updateCurrentUserAvatarDiscord.mockClear();
    updateSelfNicknameDiscord.mockClear();
    clearGateways();
    registerGateway(undefined, createMockGateway());
  });

  it("sets playing activity", async () => {
    const result = await handleDiscordPresenceAction(
      "setPresence",
      { activityType: "playing", activityName: "with fire", status: "online" },
      presenceEnabled,
    );
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [{ name: "with fire", type: 0 }],
      status: "online",
      afk: false,
    });
    const payload = result.details as {
      ok: boolean;
      activities: Array<{ type: number; name: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.activities[0]).toEqual({ type: 0, name: "with fire" });
  });

  it.each([
    {
      name: "streaming activity with URL",
      params: {
        activityType: "streaming",
        activityName: "My Stream",
        activityUrl: "https://twitch.tv/example",
      },
      expectedActivities: [{ name: "My Stream", type: 1, url: "https://twitch.tv/example" }],
    },
    {
      name: "streaming activity without URL",
      params: { activityType: "streaming", activityName: "My Stream" },
      expectedActivities: [{ name: "My Stream", type: 1 }],
    },
    {
      name: "listening activity",
      params: { activityType: "listening", activityName: "Spotify" },
      expectedActivities: [{ name: "Spotify", type: 2 }],
    },
    {
      name: "watching activity",
      params: { activityType: "watching", activityName: "you" },
      expectedActivities: [{ name: "you", type: 3 }],
    },
    {
      name: "custom activity using state",
      params: { activityType: "custom", activityState: "Vibing" },
      expectedActivities: [{ name: "Custom Status", type: 4, state: "Vibing" }],
    },
    {
      name: "activity with state",
      params: { activityType: "playing", activityName: "My Game", activityState: "In the lobby" },
      expectedActivities: [{ name: "My Game", type: 0, state: "In the lobby" }],
    },
    {
      name: "default empty activity name when only type provided",
      params: { activityType: "playing" },
      expectedActivities: [{ name: "", type: 0 }],
    },
  ])("sets $name", async ({ params, expectedActivities }) => {
    await setPresence(params);
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: expectedActivities,
      status: "online",
      afk: false,
    });
  });

  it("sets status-only without activity", async () => {
    await setPresence({ status: "idle" });
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [],
      status: "idle",
      afk: false,
    });
  });

  it.each([
    { name: "invalid status", params: { status: "offline" }, expectedMessage: /Invalid status/ },
    {
      name: "invalid activity type",
      params: { activityType: "invalid" },
      expectedMessage: /Invalid activityType/,
    },
  ])("rejects $name", async ({ params, expectedMessage }) => {
    await expect(setPresence(params)).rejects.toThrow(expectedMessage);
  });

  it("defaults status to online", async () => {
    await setPresence({ activityType: "playing", activityName: "test" });
    expect(mockUpdatePresence).toHaveBeenCalledWith(expect.objectContaining({ status: "online" }));
  });

  it("respects presence gating", async () => {
    await expect(setPresence({ status: "online" }, presenceDisabled)).rejects.toThrow(/disabled/);
  });

  it("errors when gateway is not registered", async () => {
    clearGateways();
    await expect(setPresence({ status: "dnd" })).rejects.toThrow(/not available/);
  });

  it("errors when gateway is not connected", async () => {
    clearGateways();
    registerGateway(undefined, createMockGateway(false));
    await expect(setPresence({ status: "dnd" })).rejects.toThrow(/not connected/);
  });

  it("uses accountId to resolve gateway", async () => {
    const accountGateway = createMockGateway();
    registerGateway("my-account", accountGateway);
    await setPresence({ accountId: "my-account", activityType: "playing", activityName: "test" });
    expect(mockUpdatePresence).toHaveBeenCalled();
  });

  it("requires activityType when activityName is provided", async () => {
    await expect(setPresence({ activityName: "My Game" })).rejects.toThrow(
      /activityType is required/,
    );
  });

  it("updates self profile fields (nickname/avatar/presence)", async () => {
    const result = await updateSelfProfile({
      guildId: "guild-1",
      nickname: "OpenClaw Bot",
      userId: "user:bot-1",
      buffer: "Zm9v",
      contentType: "image/png",
      status: "idle",
      statusMessage: "Shipping features",
    });

    expect(fetchCurrentUserDiscord).toHaveBeenCalledWith();
    expect(updateSelfNicknameDiscord).toHaveBeenCalledWith({
      guildId: "guild-1",
      nickname: "OpenClaw Bot",
    });
    expect(updateCurrentUserAvatarDiscord).toHaveBeenCalledWith({
      avatar: "data:image/png;base64,Zm9v",
    });
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [{ name: "Custom Status", type: 4, state: "Shipping features" }],
      status: "idle",
      afk: false,
    });

    const payload = result.details as {
      ok: boolean;
      selfUserId: string;
      updates: Record<string, unknown>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.selfUserId).toBe("bot-1");
    expect(payload.updates).toEqual(
      expect.objectContaining({
        nickname: { guildId: "guild-1", nickname: "OpenClaw Bot" },
        avatar: { updated: true },
      }),
    );
  });

  it("rejects non-self user selectors", async () => {
    await expect(
      updateSelfProfile({ guildId: "guild-1", nickname: "Nope", userId: "user:bot-2" }),
    ).rejects.toThrow(/restricted to the bot account/);
    expect(updateSelfNicknameDiscord).not.toHaveBeenCalled();
  });

  it("rejects when no update fields are provided", async () => {
    await expect(updateSelfProfile({ userId: "user:bot-1" })).rejects.toThrow(
      /No self-profile fields provided/,
    );
  });

  it("requires guildId when nickname is provided", async () => {
    await expect(updateSelfProfile({ nickname: "Nick" })).rejects.toThrow(/guildId required/);
  });

  it("continues other steps in bestEffort mode when nickname is missing guildId", async () => {
    const result = await updateSelfProfile({
      nickname: "Nick",
      buffer: "Zm9v",
      contentType: "image/png",
      bestEffort: true,
    });

    const payload = result.details as {
      ok: boolean;
      partial: boolean;
      updates: Record<string, unknown>;
      errors: Array<{ step: string; message: string }>;
    };

    expect(payload.ok).toBe(false);
    expect(payload.partial).toBe(true);
    expect(payload.updates).toEqual({ avatar: { updated: true } });
    expect(payload.errors).toHaveLength(1);
    expect(payload.errors[0]?.step).toBe("nickname");
    expect(payload.errors[0]?.message).toMatch(/guildId required/i);
    expect(updateCurrentUserAvatarDiscord).toHaveBeenCalledWith({
      avatar: "data:image/png;base64,Zm9v",
    });
  });

  it("rejects avatar buffers without a valid image content type", async () => {
    await expect(updateSelfProfile({ buffer: "Zm9v", contentType: "text/plain" })).rejects.toThrow(
      /avatar updates require PNG, JPEG, GIF, or WEBP/i,
    );
  });

  it("rejects invalid avatar base64 buffers", async () => {
    await expect(
      updateSelfProfile({
        buffer: "this is not base64@@",
        contentType: "image/png",
      }),
    ).rejects.toThrow(/must be valid base64/i);
  });

  it("rejects avatar buffers that exceed Discord size limits", async () => {
    const tooLargeBase64 = Buffer.alloc(10 * 1024 * 1024 + 1, 0).toString("base64");
    await expect(
      updateSelfProfile({
        buffer: tooLargeBase64,
        contentType: "image/png",
      }),
    ).rejects.toThrow(/exceeds the Discord limit of 10 MB/i);
  });

  it("updates nickname without needing an active gateway connection", async () => {
    clearGateways();
    await updateSelfProfile({ guildId: "guild-1", nickname: "Only Nick" });
    expect(updateSelfNicknameDiscord).toHaveBeenCalledWith({
      guildId: "guild-1",
      nickname: "Only Nick",
    });
    expect(mockUpdatePresence).not.toHaveBeenCalled();
  });

  it("fails before REST mutations when presence fields are requested and gateway is disconnected", async () => {
    clearGateways();

    await expect(
      updateSelfProfile({
        guildId: "guild-1",
        nickname: "Nick + Presence",
        status: "online",
      }),
    ).rejects.toThrow(/gateway not available|gateway is not connected/i);

    expect(updateSelfNicknameDiscord).not.toHaveBeenCalled();
    expect(updateCurrentUserAvatarDiscord).not.toHaveBeenCalled();
    expect(mockUpdatePresence).not.toHaveBeenCalled();
  });

  it("returns partial result in bestEffort mode when one step fails", async () => {
    updateCurrentUserAvatarDiscord.mockRejectedValueOnce(new Error("avatar upload failed"));

    const result = await updateSelfProfile({
      guildId: "guild-1",
      nickname: "Still Apply Nick",
      buffer: "Zm9v",
      contentType: "image/png",
      bestEffort: true,
    });

    const payload = result.details as {
      ok: boolean;
      partial: boolean;
      updates: Record<string, unknown>;
      errors: Array<{ step: string; message: string }>;
    };

    expect(payload.ok).toBe(false);
    expect(payload.partial).toBe(true);
    expect(payload.updates).toEqual({
      nickname: { guildId: "guild-1", nickname: "Still Apply Nick" },
    });
    expect(payload.errors).toEqual([{ step: "avatar", message: "avatar upload failed" }]);
  });

  it("reports applied steps when a later step fails without bestEffort", async () => {
    updateCurrentUserAvatarDiscord.mockRejectedValueOnce(new Error("avatar upload failed"));

    await expect(
      updateSelfProfile({
        guildId: "guild-1",
        nickname: "Still Apply Nick",
        buffer: "Zm9v",
        contentType: "image/png",
      }),
    ).rejects.toThrow(/Applied before failure: nickname/);
  });

  it("uses accountId for self-profile REST and gateway operations", async () => {
    registerGateway("my-account", createMockGateway());
    await updateSelfProfile(
      {
        accountId: "my-account",
        guildId: "guild-1",
        nickname: "Per Account",
        status: "online",
      },
      presenceAndSelfProfileEnabled,
    );
    expect(fetchCurrentUserDiscord).toHaveBeenCalledWith({ accountId: "my-account" });
    expect(updateSelfNicknameDiscord).toHaveBeenCalledWith(
      {
        guildId: "guild-1",
        nickname: "Per Account",
      },
      { accountId: "my-account" },
    );
    expect(mockUpdatePresence).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "online",
      }),
    );
  });

  it("respects self-profile gating", async () => {
    await expect(
      updateSelfProfile({ guildId: "guild-1", nickname: "n" }, presenceEnabled),
    ).rejects.toThrow(/self-profile updates are disabled/);
  });

  it("rejects unknown presence actions", async () => {
    await expect(
      handleDiscordPresenceAction("unknownAction", {}, presenceAndSelfProfileEnabled),
    ).rejects.toThrow(/Unknown presence action/);
  });
});
