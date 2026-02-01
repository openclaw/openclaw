import { describe, expect, it, vi } from "vitest";

import { resolveSlackUserAllowlist } from "./resolve-users.js";

describe("resolveSlackUserAllowlist", () => {
  it("resolves by name and prefers non-deleted users", async () => {
    const client = {
      users: {
        list: vi.fn().mockResolvedValue({
          members: [
            { id: "U1", name: "john", deleted: true, profile: { display_name: "John" } },
            { id: "U2", name: "john", deleted: false, profile: { display_name: "John Doe" } },
          ],
        }),
      },
    };

    const res = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["@john"],
      client: client as never,
    });

    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.id).toBe("U2");
  });

  it("keeps unresolved entries", async () => {
    const client = {
      users: {
        list: vi.fn().mockResolvedValue({ members: [] }),
      },
    };

    const res = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["@does-not-exist"],
      client: client as never,
    });

    expect(res[0]?.resolved).toBe(false);
  });

  it("skips API call when all entries are user IDs", async () => {
    const client = {
      users: {
        list: vi.fn().mockResolvedValue({ members: [] }),
      },
    };

    const res = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["U07SQFJCAU8", "U0ABVPJ1W7P"],
      client: client as never,
    });

    // Should NOT call users.list when all entries are user IDs
    expect(client.users.list).not.toHaveBeenCalled();

    // All entries should still be resolved
    expect(res).toHaveLength(2);
    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.id).toBe("U07SQFJCAU8");
    expect(res[1]?.resolved).toBe(true);
    expect(res[1]?.id).toBe("U0ABVPJ1W7P");
  });

  it("calls API when entries contain a mix of IDs and names", async () => {
    const client = {
      users: {
        list: vi.fn().mockResolvedValue({
          members: [
            { id: "U123", name: "john", deleted: false, profile: { display_name: "John" } },
          ],
        }),
      },
    };

    const res = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["U07SQFJCAU8", "@john"],
      client: client as never,
    });

    // Should call users.list because there's a name-based entry
    expect(client.users.list).toHaveBeenCalled();

    expect(res).toHaveLength(2);
    expect(res[0]?.id).toBe("U07SQFJCAU8");
    expect(res[1]?.id).toBe("U123");
  });

  it("handles Slack mention format without API call", async () => {
    const client = {
      users: {
        list: vi.fn().mockResolvedValue({ members: [] }),
      },
    };

    const res = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["<@U07SQFJCAU8>"],
      client: client as never,
    });

    // Should NOT call API for mention format (already has ID)
    expect(client.users.list).not.toHaveBeenCalled();

    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.id).toBe("U07SQFJCAU8");
  });

  it("calls API when entry is an email", async () => {
    const client = {
      users: {
        list: vi.fn().mockResolvedValue({
          members: [
            {
              id: "U123",
              name: "john",
              deleted: false,
              profile: { display_name: "John", email: "john@example.com" },
            },
          ],
        }),
      },
    };

    const res = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["john@example.com"],
      client: client as never,
    });

    // Should call users.list for email resolution
    expect(client.users.list).toHaveBeenCalled();

    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.id).toBe("U123");
    expect(res[0]?.email).toBe("john@example.com");
  });
});
