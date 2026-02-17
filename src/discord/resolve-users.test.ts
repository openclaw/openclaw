import { describe, expect, it } from "vitest";
import { resolveDiscordUserAllowlist } from "./resolve-users.js";

const unauthorizedFetcher = async () =>
  new Response(JSON.stringify({ message: "401: Unauthorized" }), { status: 401 });

const emptyGuildsFetcher = async (url: string) => {
  if (url.includes("/users/@me/guilds")) {
    return new Response(JSON.stringify([]), { status: 200 });
  }
  return new Response(JSON.stringify([]), { status: 200 });
};

const workingFetcher = async (url: string) => {
  if (url.includes("/users/@me/guilds")) {
    return new Response(JSON.stringify([{ id: "111", name: "TestGuild" }]), { status: 200 });
  }
  if (url.includes("/members/search")) {
    return new Response(
      JSON.stringify([
        {
          user: { id: "994979735488692324", username: "tonic_1", global_name: "Tonic" },
          nick: null,
        },
      ]),
      { status: 200 },
    );
  }
  return new Response(JSON.stringify([]), { status: 200 });
};

describe("resolveDiscordUserAllowlist", () => {
  it("resolves numeric user IDs without any API call", async () => {
    const results = await resolveDiscordUserAllowlist({
      token: "invalid-token",
      entries: ["994979735488692324"],
      fetcher: unauthorizedFetcher as unknown as typeof fetch,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      input: "994979735488692324",
      resolved: true,
      id: "994979735488692324",
    });
  });

  it("resolves mention-format IDs without any API call", async () => {
    const results = await resolveDiscordUserAllowlist({
      token: "invalid-token",
      entries: ["<@994979735488692324>"],
      fetcher: unauthorizedFetcher as unknown as typeof fetch,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      resolved: true,
      id: "994979735488692324",
    });
  });

  it("returns unresolved when guild lookup fails for usernames", async () => {
    const results = await resolveDiscordUserAllowlist({
      token: "bad-token",
      entries: ["tonic_1"],
      fetcher: unauthorizedFetcher as unknown as typeof fetch,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      input: "tonic_1",
      resolved: false,
    });
  });

  it("preserves resolved numeric IDs even when username lookup fails", async () => {
    const results = await resolveDiscordUserAllowlist({
      token: "bad-token",
      entries: ["994979735488692324", "tonic_1"],
      fetcher: unauthorizedFetcher as unknown as typeof fetch,
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      input: "994979735488692324",
      resolved: true,
      id: "994979735488692324",
    });
    expect(results[1]).toMatchObject({
      input: "tonic_1",
      resolved: false,
    });
  });

  it("returns unresolved for username when bot has no guilds", async () => {
    const results = await resolveDiscordUserAllowlist({
      token: "valid-token",
      entries: ["tonic_1"],
      fetcher: emptyGuildsFetcher as unknown as typeof fetch,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      input: "tonic_1",
      resolved: false,
    });
  });

  it("resolves username via guild member search", async () => {
    const results = await resolveDiscordUserAllowlist({
      token: "valid-token",
      entries: ["tonic_1"],
      fetcher: workingFetcher as unknown as typeof fetch,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      resolved: true,
      id: "994979735488692324",
      name: "Tonic",
    });
  });

  it("returns unresolved for empty token", async () => {
    const results = await resolveDiscordUserAllowlist({
      token: "",
      entries: ["tonic_1"],
      fetcher: unauthorizedFetcher as unknown as typeof fetch,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      input: "tonic_1",
      resolved: false,
    });
  });
});
