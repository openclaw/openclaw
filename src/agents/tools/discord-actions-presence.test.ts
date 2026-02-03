import type { GatewayPlugin } from "@buape/carbon/gateway";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordActionConfig } from "../../config/config.js";
import type { ActionGate } from "./common.js";
import { clearGateways, registerGateway } from "../../discord/monitor/gateway-registry.js";
import { handleDiscordPresenceAction } from "./discord-actions-presence.js";

const mockUpdatePresence = vi.fn();

function createMockGateway(connected = true): GatewayPlugin {
  return { isConnected: connected, updatePresence: mockUpdatePresence } as unknown as GatewayPlugin;
}

const presenceEnabled: ActionGate<DiscordActionConfig> = (key) => key === "presence";
const presenceDisabled: ActionGate<DiscordActionConfig> = () => false;

describe("handleDiscordPresenceAction", () => {
  beforeEach(() => {
    mockUpdatePresence.mockClear();
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
    const payload = JSON.parse(result.content[0].text ?? "");
    expect(payload.ok).toBe(true);
    expect(payload.activities[0]).toEqual({ type: 0, name: "with fire" });
  });

  it("sets streaming activity with optional URL", async () => {
    await handleDiscordPresenceAction(
      "setPresence",
      {
        activityType: "streaming",
        activityName: "My Stream",
        activityUrl: "https://twitch.tv/example",
      },
      presenceEnabled,
    );
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [{ name: "My Stream", type: 1, url: "https://twitch.tv/example" }],
      status: "online",
      afk: false,
    });
  });

  it("allows streaming without URL", async () => {
    await handleDiscordPresenceAction(
      "setPresence",
      { activityType: "streaming", activityName: "My Stream" },
      presenceEnabled,
    );
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [{ name: "My Stream", type: 1 }],
      status: "online",
      afk: false,
    });
  });

  it("sets listening activity", async () => {
    await handleDiscordPresenceAction(
      "setPresence",
      { activityType: "listening", activityName: "Spotify" },
      presenceEnabled,
    );
    expect(mockUpdatePresence).toHaveBeenCalledWith(
      expect.objectContaining({
        activities: [{ name: "Spotify", type: 2 }],
      }),
    );
  });

  it("sets watching activity", async () => {
    await handleDiscordPresenceAction(
      "setPresence",
      { activityType: "watching", activityName: "you" },
      presenceEnabled,
    );
    expect(mockUpdatePresence).toHaveBeenCalledWith(
      expect.objectContaining({
        activities: [{ name: "you", type: 3 }],
      }),
    );
  });

  it("sets custom activity using state", async () => {
    await handleDiscordPresenceAction(
      "setPresence",
      { activityType: "custom", activityState: "Vibing" },
      presenceEnabled,
    );
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [{ name: "", type: 4, state: "Vibing" }],
      status: "online",
      afk: false,
    });
  });

  it("includes activityState", async () => {
    await handleDiscordPresenceAction(
      "setPresence",
      { activityType: "playing", activityName: "My Game", activityState: "In the lobby" },
      presenceEnabled,
    );
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [{ name: "My Game", type: 0, state: "In the lobby" }],
      status: "online",
      afk: false,
    });
  });

  it("sets status-only without activity", async () => {
    await handleDiscordPresenceAction("setPresence", { status: "idle" }, presenceEnabled);
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [],
      status: "idle",
      afk: false,
    });
  });

  it("defaults status to online", async () => {
    await handleDiscordPresenceAction(
      "setPresence",
      { activityType: "playing", activityName: "test" },
      presenceEnabled,
    );
    expect(mockUpdatePresence).toHaveBeenCalledWith(expect.objectContaining({ status: "online" }));
  });

  it("rejects invalid status", async () => {
    await expect(
      handleDiscordPresenceAction("setPresence", { status: "offline" }, presenceEnabled),
    ).rejects.toThrow(/Invalid status/);
  });

  it("rejects invalid activity type", async () => {
    await expect(
      handleDiscordPresenceAction("setPresence", { activityType: "invalid" }, presenceEnabled),
    ).rejects.toThrow(/Invalid activityType/);
  });

  it("respects presence gating", async () => {
    await expect(
      handleDiscordPresenceAction("setPresence", { status: "online" }, presenceDisabled),
    ).rejects.toThrow(/disabled/);
  });

  it("errors when gateway is not registered", async () => {
    clearGateways();
    await expect(
      handleDiscordPresenceAction("setPresence", { status: "dnd" }, presenceEnabled),
    ).rejects.toThrow(/not available/);
  });

  it("errors when gateway is not connected", async () => {
    clearGateways();
    registerGateway(undefined, createMockGateway(false));
    await expect(
      handleDiscordPresenceAction("setPresence", { status: "dnd" }, presenceEnabled),
    ).rejects.toThrow(/not connected/);
  });

  it("uses accountId to resolve gateway", async () => {
    const accountGateway = createMockGateway();
    registerGateway("my-account", accountGateway);
    await handleDiscordPresenceAction(
      "setPresence",
      { accountId: "my-account", activityType: "playing", activityName: "test" },
      presenceEnabled,
    );
    expect(mockUpdatePresence).toHaveBeenCalled();
  });

  it("defaults activity name to empty string when only type is provided", async () => {
    await handleDiscordPresenceAction("setPresence", { activityType: "playing" }, presenceEnabled);
    expect(mockUpdatePresence).toHaveBeenCalledWith(
      expect.objectContaining({
        activities: [{ name: "", type: 0 }],
      }),
    );
  });

  it("rejects unknown presence actions", async () => {
    await expect(handleDiscordPresenceAction("unknownAction", {}, presenceEnabled)).rejects.toThrow(
      /Unknown presence action/,
    );
  });
});
