import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";

vi.mock("./client.js", () => ({
  createSlackWebClient: () => ({}),
}));

const { resolveSlackUserAllowlist } = await import("./resolve-users.js");

function makeMockClient(opts: {
  usersInfo?: Record<
    string,
    {
      id: string;
      name: string;
      deleted?: boolean;
      is_bot?: boolean;
      profile?: Record<string, string>;
    }
  >;
  usersList?: Array<{
    id: string;
    name: string;
    deleted?: boolean;
    is_bot?: boolean;
    profile?: Record<string, string>;
  }>;
}): WebClient {
  return {
    users: {
      info: vi.fn(async (params: { user: string }) => {
        const user = opts.usersInfo?.[params.user];
        if (!user) {
          throw new Error(`user_not_found`);
        }
        return { ok: true, user };
      }),
      list: vi.fn(async () => ({
        members: opts.usersList ?? [],
        response_metadata: { next_cursor: "" },
      })),
    },
  } as unknown as WebClient;
}

describe("resolveSlackUserAllowlist", () => {
  it("resolves ID-based entries via users.info without calling users.list", async () => {
    const client = makeMockClient({
      usersInfo: {
        U123ABC: {
          id: "U123ABC",
          name: "alice",
          profile: { display_name: "Alice Smith", email: "alice@example.com" },
        },
      },
    });

    const results = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["U123ABC"],
      client,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(
      expect.objectContaining({
        input: "U123ABC",
        resolved: true,
        id: "U123ABC",
        name: "Alice Smith",
        email: "alice@example.com",
      }),
    );
    expect(client.users.info).toHaveBeenCalledWith({ user: "U123ABC" });
    expect(client.users.list).not.toHaveBeenCalled();
  });

  it("resolves name-based entries via users.list", async () => {
    const client = makeMockClient({
      usersList: [{ id: "U999", name: "bob", profile: { display_name: "Bob Jones" } }],
    });

    const results = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["@bob"],
      client,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(
      expect.objectContaining({ resolved: true, id: "U999", name: "Bob Jones" }),
    );
    expect(client.users.list).toHaveBeenCalled();
    expect(client.users.info).not.toHaveBeenCalled();
  });

  it("resolves mixed ID and name entries using appropriate methods", async () => {
    const client = makeMockClient({
      usersInfo: {
        U111: { id: "U111", name: "carol", profile: { display_name: "Carol" } },
      },
      usersList: [{ id: "U222", name: "dave", profile: { display_name: "Dave" } }],
    });

    const results = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["U111", "@dave"],
      client,
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(expect.objectContaining({ id: "U111", name: "Carol" }));
    expect(results[1]).toEqual(expect.objectContaining({ id: "U222", name: "Dave" }));
    expect(client.users.info).toHaveBeenCalledTimes(1);
    expect(client.users.list).toHaveBeenCalledTimes(1);
  });

  it("preserves original entry order in results", async () => {
    const client = makeMockClient({
      usersInfo: {
        U111: { id: "U111", name: "first" },
      },
      usersList: [{ id: "U222", name: "second", profile: { display_name: "Second" } }],
    });

    const results = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["@second", "U111"],
      client,
    });

    expect(results).toHaveLength(2);
    expect(results[0].input).toBe("@second");
    expect(results[1].input).toBe("U111");
  });

  it("gracefully handles users.info failure for ID entries", async () => {
    const client = makeMockClient({ usersInfo: {} });

    const results = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["UNOTEXIST"],
      client,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(
      expect.objectContaining({ input: "UNOTEXIST", resolved: true, id: "UNOTEXIST" }),
    );
    expect(client.users.list).not.toHaveBeenCalled();
  });

  it("resolves email-based entries via users.list", async () => {
    const client = makeMockClient({
      usersList: [
        { id: "U333", name: "eve", profile: { email: "eve@co.com", display_name: "Eve" } },
      ],
    });

    const results = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["eve@co.com"],
      client,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(
      expect.objectContaining({ resolved: true, id: "U333", name: "Eve" }),
    );
    expect(client.users.list).toHaveBeenCalled();
  });

  it("skips users.list entirely when all entries are IDs", async () => {
    const client = makeMockClient({
      usersInfo: {
        UAAA: { id: "UAAA", name: "a" },
        UBBB: { id: "UBBB", name: "b" },
      },
    });

    const results = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["UAAA", "UBBB"],
      client,
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(expect.objectContaining({ id: "UAAA" }));
    expect(results[1]).toEqual(expect.objectContaining({ id: "UBBB" }));
    expect(client.users.list).not.toHaveBeenCalled();
    expect(client.users.info).toHaveBeenCalledTimes(2);
  });

  it("deduplicates users.info calls for repeated IDs", async () => {
    const client = makeMockClient({
      usersInfo: {
        UDUPE: { id: "UDUPE", name: "dupeuser", profile: { display_name: "Dupe User" } },
      },
    });

    const results = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["UDUPE", "UDUPE", "UDUPE"],
      client,
    });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.id === "UDUPE")).toBe(true);
    expect(client.users.info).toHaveBeenCalledTimes(1);
    expect(client.users.list).not.toHaveBeenCalled();
  });

  it("resolves mention-format IDs via users.info", async () => {
    const client = makeMockClient({
      usersInfo: {
        U123: { id: "U123", name: "mentioned", profile: { display_name: "Mentioned User" } },
      },
    });

    const results = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["<@U123>"],
      client,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(
      expect.objectContaining({ resolved: true, id: "U123", name: "Mentioned User" }),
    );
    expect(client.users.info).toHaveBeenCalledWith({ user: "U123" });
    expect(client.users.list).not.toHaveBeenCalled();
  });
});
