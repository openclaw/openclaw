import { assert, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelDirectoryEntry } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { mockFirstRecordArg } from "../../test-utils/mock-call-assertions.js";
type TargetResolverModule = typeof import("./target-resolver.js");
type ResolutionOverrides = Partial<Parameters<TargetResolverModule["resolveChannelTarget"]>[0]>;
const cfg = {} as OpenClawConfig;

let resetDirectoryCache: TargetResolverModule["resetDirectoryCache"];
let resolveMessagingTarget: TargetResolverModule["resolveChannelTarget"];
let formatTargetDisplay: TargetResolverModule["formatTargetDisplay"];

const mocks = vi.hoisted(() => ({
  listPeers: vi.fn(),
  listPeersLive: vi.fn(),
  listGroups: vi.fn(),
  listGroupsLive: vi.fn(),
  resolveTarget: vi.fn(),
  getChannelPlugin: vi.fn(),
  getLoadedChannelPlugin: vi.fn(),
  getActivePluginChannelRegistryVersion: vi.fn(() => 1),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: (...args: unknown[]) => mocks.getLoadedChannelPlugin(...args),
  getChannelPlugin: (...args: unknown[]) => mocks.getChannelPlugin(...args),
  normalizeChannelId: (value: string) => value,
}));

vi.mock("../../channels/plugins/registry-loaded.js", () => ({
  getLoadedChannelPluginForRead: (...args: unknown[]) => mocks.getLoadedChannelPlugin(...args),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginChannelRegistry: () => null,
  getActivePluginRegistry: () => null,
  getActivePluginChannelRegistryVersion: () => mocks.getActivePluginChannelRegistryVersion(),
}));

beforeAll(async () => {
  const targetResolver = await import("./target-resolver.js");
  resetDirectoryCache = targetResolver.resetDirectoryCache;
  resolveMessagingTarget = targetResolver.resolveChannelTarget;
  formatTargetDisplay = targetResolver.formatTargetDisplay;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.getLoadedChannelPlugin.mockImplementation((...args: unknown[]) =>
    mocks.getChannelPlugin(...args),
  );
  mocks.getActivePluginChannelRegistryVersion.mockReturnValue(1);
  resetDirectoryCache();
});

const directory = {
  listPeers: mocks.listPeers,
  listPeersLive: mocks.listPeersLive,
  listGroups: mocks.listGroups,
  listGroupsLive: mocks.listGroupsLive,
};
const targetResolver = { resolveTarget: mocks.resolveTarget };
const peerDirectory = { listPeers: mocks.listPeers, listPeersLive: mocks.listPeersLive };
const phoneTarget = { to: "+15551234567", kind: "user", source: "normalized" };

function directPlugin(messaging: ChannelPlugin["messaging"] = {}, live = true) {
  setPlugin(
    { inferTargetChatType: () => "direct", targetResolver, ...messaging },
    live ? peerDirectory : { listPeers: mocks.listPeers },
  );
}

function normalizedTarget(to: string, kind: "user" | "group") {
  return { to, kind, display: to, source: "normalized", resolutionSource: "normalized" };
}

function setPlugin(
  messaging: ChannelPlugin["messaging"],
  directoryMethods?: ChannelPlugin["directory"],
) {
  mocks.getChannelPlugin.mockReturnValue({
    ...createChannelTestPluginBase({
      id: "richchat",
      capabilities: { chatTypes: ["direct", "group"] },
    }),
    directory: directoryMethods,
    messaging,
  } satisfies ChannelPlugin);
}

function resolve(input: string, params: ResolutionOverrides = {}) {
  return resolveMessagingTarget({ cfg, channel: "richchat", ...params, input });
}

function expectFailure(result: Awaited<ReturnType<typeof resolve>>) {
  expect(result.ok).toBe(false);
  assert(!result.ok, "expected failed target resolution");
  return result;
}

function reservedPlugin(messaging: ChannelPlugin["messaging"] = {}) {
  mocks.getChannelPlugin.mockReturnValue({
    ...createChannelTestPluginBase({
      id: "telegram",
      label: "Telegram",
      capabilities: { chatTypes: ["direct", "group", "channel"] },
    }),
    directory,
    messaging: {
      ...messaging,
      targetResolver: {
        ...targetResolver,
        reservedLiterals: ["current", "self", "this", "me"],
        hint: "<chatId>",
        ...messaging.targetResolver,
      },
    },
  });
}

async function expectOkResolution(input: string, params: ResolutionOverrides = {}) {
  const result = await resolve(input, params);
  expect(result.ok).toBe(true);
  assert(result.ok, "expected successful target resolution");
  return result;
}

describe("resolveMessagingTarget (directory fallback)", () => {
  beforeEach(() => {
    setPlugin({ targetResolver }, directory);
  });

  it("does not reuse query-filtered directory misses for later target queries", async () => {
    directPlugin();
    const listMatchingPeers = vi.fn(({ query }: { query?: string }) =>
      query === "dm" ? [{ kind: "user", id: "+15551234567", name: "ops-dm" }] : [],
    );
    mocks.listPeers.mockImplementation(listMatchingPeers);
    mocks.listPeersLive.mockImplementation(listMatchingPeers);
    mocks.resolveTarget.mockResolvedValue(null);

    const miss = await resolve("alpha");
    expect(miss.ok).toBe(false);

    const hit = await expectOkResolution("dm");

    expect(hit.target).toEqual({
      to: "+15551234567",
      kind: "user",
      display: "ops-dm",
      source: "directory",
      resolutionSource: "directory",
    });
    expect(mocks.listPeers).toHaveBeenCalledTimes(2);
    expect(listMatchingPeers).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ query: "alpha" }),
    );
    expect(listMatchingPeers).toHaveBeenNthCalledWith(3, expect.objectContaining({ query: "dm" }));
  });

  it("does not fall back to plugin target resolution after directory errors", async () => {
    directPlugin({}, false);
    mocks.listPeers.mockRejectedValue(new Error("Alias ops is invalid."));
    mocks.resolveTarget.mockResolvedValue({ ...phoneTarget, source: "directory" });

    await expect(resolve("ops")).rejects.toThrow("Alias ops is invalid.");
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
  });

  it("keeps reserved literals on the directory path before id-like plugin normalization", async () => {
    reservedPlugin({
      normalizeTarget: (raw: string) =>
        raw === "current" || raw === "telegram:current" ? "telegram:@current" : raw,
      targetResolver: {
        looksLikeId: (raw: string) => raw === "current" || raw === "telegram:current",
      },
    });
    const current = [
      { kind: "group", id: "room-1", name: "current" },
    ] satisfies ChannelDirectoryEntry[];
    mocks.listGroups.mockResolvedValueOnce(current);

    const hit = await expectOkResolution("current", { channel: "telegram" });
    expect(hit.target).toMatchObject({ to: "room-1", source: "directory" });
    expect(mocks.resolveTarget).not.toHaveBeenCalled();

    resetDirectoryCache();
    mocks.listGroups.mockResolvedValueOnce(current);

    const prefixedHit = await expectOkResolution("telegram:current", { channel: "telegram" });
    expect(prefixedHit.target).toMatchObject({ to: "room-1", source: "directory" });

    resetDirectoryCache();
    mocks.listGroups.mockResolvedValueOnce([]);
    mocks.listGroupsLive.mockResolvedValueOnce([]);

    const miss = expectFailure(await resolve("current", { channel: "telegram" }));
    expect(miss.error.message).toContain('Reserved target "current"');
    expect(miss.error.message).toContain("Telegram");
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
  });

  it("requires exact directory matches before preserving reserved literal targets", async () => {
    reservedPlugin();
    mocks.listGroups.mockResolvedValue([
      { kind: "group", id: "memes-room", name: "memes" } satisfies ChannelDirectoryEntry,
    ]);
    mocks.listGroupsLive.mockResolvedValue([]);

    const result = expectFailure(await resolve("me", { channel: "telegram" }));
    expect(result.error.message).toContain('Reserved target "me"');
    expect(result.error.message).toContain("Telegram");
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
  });

  it("does not reuse directory cache entries across prepared plugin runtimes", async () => {
    const groupPlugin = (id: string) => ({
      ...createChannelTestPluginBase({ id: "richchat", capabilities: { chatTypes: ["group"] } }),
      directory: {
        listGroups: vi
          .fn()
          .mockResolvedValue([
            { kind: "group", id, name: "support" } satisfies ChannelDirectoryEntry,
          ]),
      },
      messaging: { targetResolver: {} },
    });
    const firstPlugin = groupPlugin("first-id");
    const replacementPlugin = groupPlugin("replacement-id");

    const first = await expectOkResolution("support", { plugin: firstPlugin });
    const replacement = await expectOkResolution("support", { plugin: replacementPlugin });
    const cachedFirst = await expectOkResolution("support", { plugin: firstPlugin });

    expect(first.target.to).toBe("first-id");
    expect(replacement.target.to).toBe("replacement-id");
    expect(cachedFirst.target.to).toBe("first-id");
    expect(firstPlugin.directory.listGroups).toHaveBeenCalledOnce();
    expect(replacementPlugin.directory.listGroups).toHaveBeenCalledOnce();
  });

  it("defaults bare id-like targets to user for direct-only channel plugins", async () => {
    const directOnlyPlugin = {
      ...createChannelTestPluginBase({
        id: "openclaw-weixin",
        capabilities: { chatTypes: ["direct"] },
      }),
      messaging: {
        targetResolver: {
          looksLikeId: (raw: string) => raw.endsWith("@im.wechat"),
        },
      },
    } satisfies ChannelPlugin;

    const result = await expectOkResolution("wxid_abc123@im.wechat", {
      channel: "openclaw-weixin",
      plugin: directOnlyPlugin,
    });

    expect(result.target).toEqual(normalizedTarget("wxid_abc123@im.wechat", "user"));
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.listGroupsLive).not.toHaveBeenCalled();
  });

  it("uses catalog plugin target grammar for unloaded numeric topic ids", async () => {
    mocks.getLoadedChannelPlugin.mockReturnValue(undefined);
    setPlugin({
      normalizeTarget: (raw: string) =>
        raw.trim() === "-1001234567890:topic:42"
          ? "telegram:-1001234567890:topic:42"
          : raw.trim() || undefined,
      inferTargetChatType: ({ to }: { to: string }) => (to.includes("-100") ? "group" : "direct"),
      targetResolver: {
        looksLikeId: (_raw: string, normalized?: string) =>
          normalized === "telegram:-1001234567890:topic:42",
        hint: "<chatId>",
      },
    });

    const result = await expectOkResolution("-1001234567890:topic:42", { channel: "telegram" });

    expect(result.target).toEqual(normalizedTarget("telegram:-1001234567890:topic:42", "group"));
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.listGroupsLive).not.toHaveBeenCalled();
  });

  it("uses plugin chat-type inference for directory lookups and plugin fallback on miss", async () => {
    directPlugin({ targetResolver: { looksLikeId: () => false, ...targetResolver } });
    mocks.listPeers.mockResolvedValue([]);
    mocks.listPeersLive.mockResolvedValue([]);
    mocks.resolveTarget.mockResolvedValue(phoneTarget);

    const result = await expectOkResolution("+15551234567", { channel: "localchat" });
    expect(result.target).toEqual({
      ...phoneTarget,
      resolutionSource: "plugin",
      display: undefined,
    });
    expect(mocks.listPeers).toHaveBeenCalledTimes(1);
    expect(mocks.listPeersLive).toHaveBeenCalledTimes(1);
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.resolveTarget).toHaveBeenCalledOnce();
    expect(mockFirstRecordArg(mocks.resolveTarget, "target resolver").input).toBe("+15551234567");
  });

  it("fails closed after directory and plugin misses unless normalized fallback is explicit", async () => {
    mocks.listGroups.mockResolvedValue([]);
    mocks.listGroupsLive.mockResolvedValue([]);
    mocks.resolveTarget.mockResolvedValue(null);

    const rejected = await resolve("missing");
    expect(rejected.ok).toBe(false);

    const fallback = await expectOkResolution("missing", { unknownTargetMode: "normalized" });
    expect(fallback.target).toMatchObject({
      to: "missing",
      source: "normalized",
      resolutionSource: "normalized",
    });
  });

  it("fails closed when a name matches more than one directory destination", async () => {
    mocks.listGroups.mockResolvedValue([
      { kind: "group", id: "channel:1", name: "general" },
      { kind: "group", id: "channel:2", name: "general-archive" },
    ] satisfies ChannelDirectoryEntry[]);

    const result = expectFailure(await resolve("general"));
    expect(result.candidates).toHaveLength(2);
    expect(result.error.message).toContain("Ambiguous");
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
  });

  it("keeps plugin-owned id casing when resolver returns a normalized target", async () => {
    setPlugin({
      targetResolver: {
        looksLikeId: () => true,
        resolveTarget: mocks.resolveTarget,
      },
    });
    mocks.resolveTarget.mockResolvedValue({
      to: "channel:C123ABC",
      kind: "group",
      source: "normalized",
    });

    const result = await expectOkResolution("#C123ABC", { channel: "workspace" });
    expect(result.target.to).toBe("channel:C123ABC");
    expect(result.target.display).toBeUndefined();
  });

  it("defers target display formatting to the plugin when available", () => {
    setPlugin({
      formatTargetDisplay: ({ target }: { target: string }) => target.replace(/^forum:/i, ""),
    });

    expect(formatTargetDisplay({ channel: "forum", target: "forum:12345" })).toBe("12345");
  });
});

describe("resolveMessagingTarget (registry-scoped channel plugins)", () => {
  const scopedPlugin = {
    id: "zephyrchat",
    meta: { label: "ZephyrChat" },
    outbound: { sendText: async () => ({}) },
    messaging: {
      targetResolver: {
        looksLikeId: (id: string) => /^Z[0-9a-f]{8}$/i.test(id.trim()),
        hint: "<zephyrId>",
      },
    },
  } as unknown as ChannelPlugin;
  const scopedRegistry = {
    channels: [{ plugin: scopedPlugin }],
  } as unknown as import("../../plugins/registry-types.js").PluginRegistry;

  beforeEach(() => {
    mocks.getChannelPlugin.mockReturnValue(undefined);
    mocks.getLoadedChannelPlugin.mockReturnValue(undefined);
  });

  it("keeps the scoped plugin's label and hint on an unknown target", async () => {
    const { withPluginRuntimeRegistryScope } =
      await import("../../plugins/runtime/gateway-request-scope.js");
    const result = expectFailure(
      await withPluginRuntimeRegistryScope(scopedRegistry, () =>
        resolve("not an id", { channel: "zephyrchat" }),
      ),
    );
    expect(result.error.message).toBe(
      'Unknown target "not an id" for ZephyrChat. Hint: <zephyrId>',
    );
  });

  it("still reports an unknown target without the scope", async () => {
    const result = expectFailure(await resolve("Zdeadbeef", { channel: "zephyrchat" }));
    expect(result.error.message).toBe('Unknown target "Zdeadbeef" for zephyrchat.');
  });
});
