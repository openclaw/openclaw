import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelDirectoryEntry } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resetDirectoryCache, resolveMessagingTarget } from "./target-resolver.js";

const mocks = vi.hoisted(() => ({
  listGroups: vi.fn(),
  listGroupsLive: vi.fn(),
  getChannelPlugin: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => mocks.getChannelPlugin(...args),
  normalizeChannelId: (value: string) => value,
}));

describe("resolveMessagingTarget (directory fallback)", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    mocks.listGroups.mockClear();
    mocks.listGroupsLive.mockClear();
    mocks.getChannelPlugin.mockClear();
    resetDirectoryCache();
    mocks.getChannelPlugin.mockReturnValue({
      directory: {
        listGroups: mocks.listGroups,
        listGroupsLive: mocks.listGroupsLive,
      },
    });
  });

  it("uses live directory fallback and caches the result", async () => {
    const entry: ChannelDirectoryEntry = { kind: "group", id: "123456789", name: "support" };
    mocks.listGroups.mockResolvedValue([]);
    mocks.listGroupsLive.mockResolvedValue([entry]);

    const first = await resolveMessagingTarget({
      cfg,
      channel: "discord",
      input: "support",
    });

    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.target.source).toBe("directory");
      expect(first.target.to).toBe("123456789");
    }
    expect(mocks.listGroups).toHaveBeenCalledTimes(1);
    expect(mocks.listGroupsLive).toHaveBeenCalledTimes(1);

    const second = await resolveMessagingTarget({
      cfg,
      channel: "discord",
      input: "support",
    });

    expect(second.ok).toBe(true);
    expect(mocks.listGroups).toHaveBeenCalledTimes(1);
    expect(mocks.listGroupsLive).toHaveBeenCalledTimes(1);
  });

  it("skips directory lookup for direct ids", async () => {
    const result = await resolveMessagingTarget({
      cfg,
      channel: "discord",
      input: "123456789",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.source).toBe("normalized");
      expect(result.target.to).toBe("123456789");
    }
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.listGroupsLive).not.toHaveBeenCalled();
  });

  it("uses plugin defaultTargetKind for bare names", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      messaging: {
        targetResolver: {
          looksLikeId: () => true,
          defaultTargetKind: "user",
        },
      },
      directory: {
        listGroups: mocks.listGroups,
        listGroupsLive: mocks.listGroupsLive,
      },
    });

    const result = await resolveMessagingTarget({
      cfg,
      channel: "custom",
      input: "alice",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.source).toBe("normalized");
      expect(result.target.to).toBe("alice");
      expect(result.target.kind).toBe("user");
    }
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.listGroupsLive).not.toHaveBeenCalled();
  });

  it("preserves explicit group prefixes ahead of plugin defaultTargetKind", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      messaging: {
        targetResolver: {
          looksLikeId: () => true,
          defaultTargetKind: "user",
        },
      },
      directory: {
        listGroups: mocks.listGroups,
        listGroupsLive: mocks.listGroupsLive,
      },
    });

    const result = await resolveMessagingTarget({
      cfg,
      channel: "custom",
      input: "group:family-room",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.source).toBe("normalized");
      expect(result.target.to).toBe("group:family-room");
      expect(result.target.kind).toBe("group");
    }
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.listGroupsLive).not.toHaveBeenCalled();
  });

  it("strips explicit group prefixes before directory lookup when plugin looksLikeId returns false", async () => {
    const entry: ChannelDirectoryEntry = {
      kind: "group",
      id: "family-room",
      name: "family-room",
    };
    mocks.getChannelPlugin.mockReturnValue({
      messaging: {
        targetResolver: {
          looksLikeId: () => false,
          defaultTargetKind: "user",
        },
      },
      directory: {
        listGroups: mocks.listGroups,
        listGroupsLive: mocks.listGroupsLive,
      },
    });
    mocks.listGroups.mockResolvedValue([]);
    mocks.listGroupsLive.mockResolvedValue([entry]);

    const result = await resolveMessagingTarget({
      cfg,
      channel: "custom",
      input: "group:family-room",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.source).toBe("directory");
      expect(result.target.to).toBe("family-room");
      expect(result.target.kind).toBe("group");
    }
    expect(mocks.listGroups).toHaveBeenCalledTimes(1);
    expect(mocks.listGroupsLive).toHaveBeenCalledTimes(1);
  });
});
