import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelDirectoryEntry } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
type TargetResolverModule = typeof import("./target-resolver.js");

let resetDirectoryCache: TargetResolverModule["resetDirectoryCache"];
let resolveMessagingTarget: TargetResolverModule["resolveMessagingTarget"];

const mocks = vi.hoisted(() => ({
  listGroups: vi.fn(),
  listGroupsLive: vi.fn(),
  resolveTarget: vi.fn(),
  getChannelPlugin: vi.fn(),
  getActivePluginRegistryVersion: vi.fn(() => 1),
}));

beforeEach(async () => {
  vi.resetModules();
  mocks.listGroups.mockReset();
  mocks.listGroupsLive.mockReset();
  mocks.resolveTarget.mockReset();
  mocks.getChannelPlugin.mockReset();
  mocks.getActivePluginRegistryVersion.mockReset();
  mocks.getActivePluginRegistryVersion.mockReturnValue(1);
  vi.doMock("../../channels/plugins/index.js", () => ({
    getChannelPlugin: (...args: unknown[]) => mocks.getChannelPlugin(...args),
    normalizeChannelId: (value: string) => value,
  }));
  vi.doMock("../../plugins/runtime.js", () => ({
    getActivePluginRegistryVersion: () => mocks.getActivePluginRegistryVersion(),
  }));
  ({ resetDirectoryCache, resolveMessagingTarget } = await import("./target-resolver.js"));
});

describe("resolveMessagingTarget (directory fallback)", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    resetDirectoryCache();
    mocks.getChannelPlugin.mockReturnValue({
      directory: {
        listGroups: mocks.listGroups,
        listGroupsLive: mocks.listGroupsLive,
      },
      messaging: {
        targetResolver: {
          resolveTarget: mocks.resolveTarget,
        },
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

  it("lets plugins override id-like target resolution before falling back to raw ids", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      messaging: {
        targetResolver: {
          looksLikeId: () => true,
          resolveTarget: mocks.resolveTarget,
        },
      },
    });
    mocks.resolveTarget.mockResolvedValue({
      to: "user:dm-user-id",
      kind: "user",
      source: "directory",
    });

    const result = await resolveMessagingTarget({
      cfg,
      channel: "mattermost",
      input: "dthcxgoxhifn3pwh65cut3ud3w",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({
        to: "user:dm-user-id",
        kind: "user",
        source: "directory",
        display: undefined,
      });
    }
    expect(mocks.resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "dthcxgoxhifn3pwh65cut3ud3w",
      }),
    );
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.listGroupsLive).not.toHaveBeenCalled();
  });
});
