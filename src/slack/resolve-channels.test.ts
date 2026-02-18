import { describe, expect, it, vi } from "vitest";
import { resolveSlackChannelAllowlist } from "./resolve-channels.js";

describe("resolveSlackChannelAllowlist", () => {
  it("resolves by name and prefers active channels", async () => {
    const client = {
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [
            { id: "C1", name: "general", is_archived: true },
            { id: "C2", name: "general", is_archived: false },
          ],
        }),
      },
    };

    const res = await resolveSlackChannelAllowlist({
      token: "xoxb-test",
      entries: ["#general"],
      client: client as never,
    });

    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.id).toBe("C2");
  });

  it("keeps unresolved entries", async () => {
    const client = {
      conversations: {
        list: vi.fn().mockResolvedValue({ channels: [] }),
      },
    };

    const res = await resolveSlackChannelAllowlist({
      token: "xoxb-test",
      entries: ["#does-not-exist"],
      client: client as never,
    });

    expect(res[0]?.resolved).toBe(false);
  });

  it("skips API call when all entries are channel IDs", async () => {
    const client = {
      conversations: {
        list: vi.fn().mockResolvedValue({ channels: [] }),
      },
    };

    const res = await resolveSlackChannelAllowlist({
      token: "xoxb-test",
      entries: ["C087C6LMAQZ", "C07EH07H1PS"],
      client: client as never,
    });

    // Should NOT call conversations.list when all entries are channel IDs
    expect(client.conversations.list).not.toHaveBeenCalled();

    // All entries should still be resolved
    expect(res).toHaveLength(2);
    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.id).toBe("C087C6LMAQZ");
    expect(res[1]?.resolved).toBe(true);
    expect(res[1]?.id).toBe("C07EH07H1PS");
  });

  it("calls API when entries contain a mix of IDs and names", async () => {
    const client = {
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [{ id: "C123", name: "general", is_archived: false }],
        }),
      },
    };

    const res = await resolveSlackChannelAllowlist({
      token: "xoxb-test",
      entries: ["C087C6LMAQZ", "#general"],
      client: client as never,
    });

    // Should call conversations.list because there's a name-based entry
    expect(client.conversations.list).toHaveBeenCalled();

    expect(res).toHaveLength(2);
    expect(res[0]?.id).toBe("C087C6LMAQZ");
    expect(res[1]?.id).toBe("C123");
  });

  it("handles Slack mention format without API call", async () => {
    const client = {
      conversations: {
        list: vi.fn().mockResolvedValue({ channels: [] }),
      },
    };

    const res = await resolveSlackChannelAllowlist({
      token: "xoxb-test",
      entries: ["<#C087C6LMAQZ|pbo-o4o-eng>"],
      client: client as never,
    });

    // Should NOT call API for mention format (already has ID)
    expect(client.conversations.list).not.toHaveBeenCalled();

    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.id).toBe("C087C6LMAQZ");
    expect(res[0]?.name).toBe("pbo-o4o-eng");
  });
});
