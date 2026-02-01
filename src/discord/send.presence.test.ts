import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client-registry.js", () => ({
  getDiscordGateway: vi.fn(),
}));

import { getDiscordGateway } from "./client-registry.js";
import { updatePresenceDiscord } from "./send.presence.js";

describe("updatePresenceDiscord", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when gateway is not connected", () => {
    vi.mocked(getDiscordGateway).mockReturnValue(undefined);

    const result = updatePresenceDiscord({
      status: "online",
      activityType: "playing",
      activityName: "Test Game",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Discord gateway not connected");
  });

  it("returns error with account id when gateway not found for specific account", () => {
    vi.mocked(getDiscordGateway).mockReturnValue(undefined);

    const result = updatePresenceDiscord({
      accountId: "test-account",
      status: "online",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Discord gateway not found for account: test-account");
  });

  it("updates presence with status only", () => {
    const mockUpdatePresence = vi.fn();
    vi.mocked(getDiscordGateway).mockReturnValue({
      updatePresence: mockUpdatePresence,
    } as unknown as ReturnType<typeof getDiscordGateway>);

    const result = updatePresenceDiscord({
      status: "dnd",
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe("dnd");
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [],
      status: "dnd",
      afk: false,
    });
  });

  it("updates presence with activity", () => {
    const mockUpdatePresence = vi.fn();
    vi.mocked(getDiscordGateway).mockReturnValue({
      updatePresence: mockUpdatePresence,
    } as unknown as ReturnType<typeof getDiscordGateway>);

    const result = updatePresenceDiscord({
      status: "online",
      activityType: "playing",
      activityName: "Test Game",
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe("online");
    expect(result.activity).toEqual({
      type: "playing",
      name: "Test Game",
    });
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [{ name: "Test Game", type: 0 }],
      status: "online",
      afk: false,
    });
  });

  it("includes url for streaming activity", () => {
    const mockUpdatePresence = vi.fn();
    vi.mocked(getDiscordGateway).mockReturnValue({
      updatePresence: mockUpdatePresence,
    } as unknown as ReturnType<typeof getDiscordGateway>);

    const result = updatePresenceDiscord({
      status: "online",
      activityType: "streaming",
      activityName: "Live Stream",
      activityUrl: "https://twitch.tv/test",
    });

    expect(result.success).toBe(true);
    expect(result.activity?.url).toBe("https://twitch.tv/test");
    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [{ name: "Live Stream", type: 1, url: "https://twitch.tv/test" }],
      status: "online",
      afk: false,
    });
  });

  it("does not include url for non-streaming activity", () => {
    const mockUpdatePresence = vi.fn();
    vi.mocked(getDiscordGateway).mockReturnValue({
      updatePresence: mockUpdatePresence,
    } as unknown as ReturnType<typeof getDiscordGateway>);

    const result = updatePresenceDiscord({
      status: "online",
      activityType: "playing",
      activityName: "Test Game",
      activityUrl: "https://example.com",
    });

    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [{ name: "Test Game", type: 0 }],
      status: "online",
      afk: false,
    });
  });

  it("sets afk flag when specified", () => {
    const mockUpdatePresence = vi.fn();
    vi.mocked(getDiscordGateway).mockReturnValue({
      updatePresence: mockUpdatePresence,
    } as unknown as ReturnType<typeof getDiscordGateway>);

    updatePresenceDiscord({
      status: "idle",
      afk: true,
    });

    expect(mockUpdatePresence).toHaveBeenCalledWith({
      since: null,
      activities: [],
      status: "idle",
      afk: true,
    });
  });

  it("maps activity types correctly", () => {
    const mockUpdatePresence = vi.fn();
    vi.mocked(getDiscordGateway).mockReturnValue({
      updatePresence: mockUpdatePresence,
    } as unknown as ReturnType<typeof getDiscordGateway>);

    const activityTypes = [
      { type: "playing", expected: 0 },
      { type: "streaming", expected: 1 },
      { type: "listening", expected: 2 },
      { type: "watching", expected: 3 },
      { type: "custom", expected: 4 },
      { type: "competing", expected: 5 },
    ] as const;

    for (const { type, expected } of activityTypes) {
      mockUpdatePresence.mockClear();
      updatePresenceDiscord({
        activityType: type,
        activityName: "Test",
      });
      expect(mockUpdatePresence).toHaveBeenCalledWith(
        expect.objectContaining({
          activities: [expect.objectContaining({ type: expected })],
        }),
      );
    }
  });
});
