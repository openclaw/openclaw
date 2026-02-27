import { describe, expect, it } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { resolveDiscordChannelAllowlist } from "./resolve-channels.js";
import { jsonResponse, urlToString } from "./test-http-helpers.js";

describe("resolveDiscordChannelAllowlist", () => {
  it("resolves guild/channel by name", async () => {
    const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse([{ id: "g1", name: "My Guild" }]);
      }
      if (url.endsWith("/guilds/g1/channels")) {
        return jsonResponse([
          { id: "c1", name: "general", guild_id: "g1", type: 0 },
          { id: "c2", name: "random", guild_id: "g1", type: 0 },
        ]);
      }
      return new Response("not found", { status: 404 });
    });

    const res = await resolveDiscordChannelAllowlist({
      token: "test",
      entries: ["My Guild/general"],
      fetcher,
    });

    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.guildId).toBe("g1");
    expect(res[0]?.channelId).toBe("c1");
  });

  it("resolves channel id to guild", async () => {
    const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse([{ id: "g1", name: "Guild One" }]);
      }
      if (url.endsWith("/channels/123")) {
        return jsonResponse({ id: "123", name: "general", guild_id: "g1", type: 0 });
      }
      return new Response("not found", { status: 404 });
    });

    const res = await resolveDiscordChannelAllowlist({
      token: "test",
      entries: ["123"],
      fetcher,
    });

    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.guildId).toBe("g1");
    expect(res[0]?.channelId).toBe("123");
  });

  it("resolves guild: prefixed id as guild (not channel)", async () => {
    const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse([{ id: "111222333444555666", name: "Guild One" }]);
      }
      // Should never be called — if it is, the ID was misrouted as a channel
      if (url.includes("/channels/")) {
        throw new Error("guild id was incorrectly routed to /channels/");
      }
      return new Response("not found", { status: 404 });
    });

    const res = await resolveDiscordChannelAllowlist({
      token: "test",
      entries: ["guild:111222333444555666"],
      fetcher,
    });

    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.guildId).toBe("111222333444555666");
    expect(res[0]?.channelId).toBeUndefined();
  });

  it("bare numeric guild id is misrouted as channel id (regression)", async () => {
    // Demonstrates why provider.ts must prefix guild-only entries with "guild:"
    // In reality, Discord returns 404 when a guild ID is sent to /channels/<guildId>,
    // which causes fetchDiscord to throw and the entire resolver to crash.
    const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse([{ id: "999", name: "My Server" }]);
      }
      // Guild ID hitting /channels/ returns 404 — just like real Discord
      if (url.includes("/channels/")) {
        return new Response(JSON.stringify({ message: "Unknown Channel" }), { status: 404 });
      }
      return new Response("not found", { status: 404 });
    });

    // Without the guild: prefix, a bare numeric string hits /channels/999 → 404 → throws
    await expect(
      resolveDiscordChannelAllowlist({
        token: "test",
        entries: ["999"],
        fetcher,
      }),
    ).rejects.toThrow(/404/);

    // With the guild: prefix, it correctly resolves as a guild (never hits /channels/)
    const res2 = await resolveDiscordChannelAllowlist({
      token: "test",
      entries: ["guild:999"],
      fetcher,
    });
    expect(res2[0]?.resolved).toBe(true);
    expect(res2[0]?.guildId).toBe("999");
    expect(res2[0]?.channelId).toBeUndefined();
  });
});
