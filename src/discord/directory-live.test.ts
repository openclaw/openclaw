import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryConfigParams } from "../channels/plugins/directory-config.js";

const mocks = vi.hoisted(() => ({
  fetchDiscord: vi.fn(),
  normalizeDiscordToken: vi.fn((token: string) => token.trim()),
  resolveDiscordAccount: vi.fn(),
}));

vi.mock("./accounts.js", () => ({
  resolveDiscordAccount: mocks.resolveDiscordAccount,
}));

vi.mock("./api.js", () => ({
  fetchDiscord: mocks.fetchDiscord,
}));

vi.mock("./token.js", () => ({
  normalizeDiscordToken: mocks.normalizeDiscordToken,
}));

import { listDiscordDirectoryGroupsLive, listDiscordDirectoryPeersLive } from "./directory-live.js";

function makeParams(overrides: Partial<DirectoryConfigParams> = {}): DirectoryConfigParams {
  return {
    cfg: {} as DirectoryConfigParams["cfg"],
    ...overrides,
  };
}

describe("discord directory live lookups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDiscordAccount.mockReturnValue({ token: "test-token" });
    mocks.normalizeDiscordToken.mockImplementation((token: string) => token.trim());
  });

  it("returns empty group directory when token is missing", async () => {
    mocks.normalizeDiscordToken.mockReturnValue("");

    const rows = await listDiscordDirectoryGroupsLive(makeParams({ query: "general" }));

    expect(rows).toEqual([]);
    expect(mocks.fetchDiscord).not.toHaveBeenCalled();
  });

  it("returns empty peer directory without query and skips guild listing", async () => {
    const rows = await listDiscordDirectoryPeersLive(makeParams({ query: "  " }));

    expect(rows).toEqual([]);
    expect(mocks.fetchDiscord).not.toHaveBeenCalled();
  });

  it("filters group channels by query and respects limit", async () => {
    mocks.fetchDiscord.mockImplementation(async (path: string) => {
      if (path === "/users/@me/guilds") {
        return [
          { id: "g1", name: "Guild 1" },
          { id: "g2", name: "Guild 2" },
        ];
      }
      if (path === "/guilds/g1/channels") {
        return [
          { id: "c1", name: "general" },
          { id: "c2", name: "random" },
        ];
      }
      if (path === "/guilds/g2/channels") {
        return [{ id: "c3", name: "announcements" }];
      }
      return [];
    });

    const rows = await listDiscordDirectoryGroupsLive(makeParams({ query: "an", limit: 2 }));

    expect(rows).toEqual([
      expect.objectContaining({ kind: "group", id: "channel:c2", name: "random" }),
      expect.objectContaining({ kind: "group", id: "channel:c3", name: "announcements" }),
    ]);
  });

  it("returns ranked peer results and caps member search by limit", async () => {
    mocks.fetchDiscord.mockImplementation(async (path: string) => {
      if (path === "/users/@me/guilds") {
        return [{ id: "g1", name: "Guild 1" }];
      }
      if (path.startsWith("/guilds/g1/members/search?")) {
        const params = new URLSearchParams(path.split("?")[1] ?? "");
        expect(params.get("query")).toBe("alice");
        expect(params.get("limit")).toBe("2");
        return [
          { user: { id: "u1", username: "alice", bot: false }, nick: "Ali" },
          { user: { id: "u2", username: "alice-bot", bot: true }, nick: null },
          { user: { id: "u3", username: "ignored", bot: false }, nick: null },
        ];
      }
      return [];
    });

    const rows = await listDiscordDirectoryPeersLive(makeParams({ query: "alice", limit: 2 }));

    expect(rows).toEqual([
      expect.objectContaining({
        kind: "user",
        id: "user:u1",
        name: "Ali",
        handle: "@alice",
        rank: 1,
      }),
      expect.objectContaining({
        kind: "user",
        id: "user:u2",
        handle: "@alice-bot",
        rank: 0,
      }),
    ]);
  });
});
