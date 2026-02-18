import { describe, expect, it } from "vitest";
import { resolveDiscordUserAllowlist } from "./resolve-users.js";

/**
 * Stub fetcher that records calls and returns canned responses.
 * Throws on unexpected paths to catch unintended API calls.
 */
function makeFetcher(responses: Record<string, unknown>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: RequestInfo | URL) => {
    const urlStr = typeof url === "string" ? url : (url as URL).href;
    const path = urlStr.replace("https://discord.com/api/v10", "");
    calls.push(path);
    const body = responses[path];
    if (body === undefined) {
      return { ok: false, status: 404, text: async () => "not found" } as Response;
    }
    return {
      ok: true,
      json: async () => body,
    } as Response;
  }) as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe("resolveDiscordUserAllowlist", () => {
  const VALID_TOKEN = "Bot MTIz.abc.def";

  it("resolves numeric user ids without any API calls", async () => {
    const fetcher = makeFetcher({});

    const results = await resolveDiscordUserAllowlist({
      token: VALID_TOKEN,
      entries: ["994979735488692324", "123456789012345678"],
      fetcher,
    });

    expect(results).toEqual([
      { input: "994979735488692324", resolved: true, id: "994979735488692324" },
      { input: "123456789012345678", resolved: true, id: "123456789012345678" },
    ]);
    // No API calls should have been made
    expect(fetcher.calls).toHaveLength(0);
  });

  it("resolves mention-form ids without API calls", async () => {
    const fetcher = makeFetcher({});

    const results = await resolveDiscordUserAllowlist({
      token: VALID_TOKEN,
      entries: ["<@994979735488692324>", "<@!123456789012345678>"],
      fetcher,
    });

    expect(results).toEqual([
      { input: "<@994979735488692324>", resolved: true, id: "994979735488692324" },
      { input: "<@!123456789012345678>", resolved: true, id: "123456789012345678" },
    ]);
    expect(fetcher.calls).toHaveLength(0);
  });

  it("resolves prefixed ids without API calls", async () => {
    const fetcher = makeFetcher({});

    const results = await resolveDiscordUserAllowlist({
      token: VALID_TOKEN,
      entries: ["user:994979735488692324", "discord:123456789012345678"],
      fetcher,
    });

    expect(results).toEqual([
      { input: "user:994979735488692324", resolved: true, id: "994979735488692324" },
      { input: "discord:123456789012345678", resolved: true, id: "123456789012345678" },
    ]);
    expect(fetcher.calls).toHaveLength(0);
  });

  it("fetches guilds only when a username needs resolution", async () => {
    const fetcher = makeFetcher({
      "/users/@me/guilds": [{ id: "111", name: "Test Guild" }],
      "/guilds/111/members/search?query=tonic_1&limit=25": [
        {
          user: { id: "999", username: "tonic_1", global_name: "Tonic" },
        },
      ],
    });

    const results = await resolveDiscordUserAllowlist({
      token: VALID_TOKEN,
      entries: ["994979735488692324", "tonic_1"],
      fetcher,
    });

    expect(results[0]).toEqual({
      input: "994979735488692324",
      resolved: true,
      id: "994979735488692324",
    });
    expect(results[1]).toMatchObject({
      input: "tonic_1",
      resolved: true,
      id: "999",
    });
    // Guild listing + member search = 2 calls (not called for the numeric id)
    expect(fetcher.calls).toHaveLength(2);
    expect(fetcher.calls[0]).toBe("/users/@me/guilds");
  });

  it("returns unresolved for empty token", async () => {
    const results = await resolveDiscordUserAllowlist({
      token: "",
      entries: ["alice"],
    });

    expect(results).toEqual([{ input: "alice", resolved: false }]);
  });

  it("returns unresolved for empty input", async () => {
    const fetcher = makeFetcher({
      "/users/@me/guilds": [],
    });

    const results = await resolveDiscordUserAllowlist({
      token: VALID_TOKEN,
      entries: [""],
      fetcher,
    });

    expect(results).toEqual([{ input: "", resolved: false }]);
    // No guild call needed for empty input
    expect(fetcher.calls).toHaveLength(0);
  });
});
