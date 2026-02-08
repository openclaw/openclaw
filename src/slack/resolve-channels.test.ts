import { describe, expect, it, vi } from "vitest";
import { resolveChannelIdForUpload, resolveSlackChannelAllowlist } from "./resolve-channels.js";

describe("resolveChannelIdForUpload", () => {
  it("returns channel ID as-is when input matches ID regex", async () => {
    const client = { conversations: { list: vi.fn() } };
    const id = await resolveChannelIdForUpload(client as never, "C024BE91L");
    expect(id).toBe("C024BE91L");
    expect(client.conversations.list).not.toHaveBeenCalled();
  });

  it("resolves #channel-name to ID via conversations.list", async () => {
    const client = {
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [{ id: "C123ABC45", name: "ems", is_archived: false }],
        }),
      },
    };
    const id = await resolveChannelIdForUpload(client as never, "#ems");
    expect(id).toBe("C123ABC45");
  });

  it("resolves bare channel name to ID", async () => {
    const client = {
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [{ id: "C999CHAN12", name: "general", is_archived: false }],
        }),
      },
    };
    const id = await resolveChannelIdForUpload(client as never, "general");
    expect(id).toBe("C999CHAN12");
  });

  it("throws when channel name not found or bot not a member", async () => {
    const client = {
      conversations: {
        list: vi.fn().mockResolvedValue({ channels: [] }),
      },
    };
    await expect(resolveChannelIdForUpload(client as never, "#does-not-exist")).rejects.toThrow(
      /not found or bot not a member/,
    );
  });

  it("throws when input is empty", async () => {
    const client = { conversations: { list: vi.fn() } };
    await expect(resolveChannelIdForUpload(client as never, "   ")).rejects.toThrow(
      /channel identifier is required/,
    );
  });
});

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
});
