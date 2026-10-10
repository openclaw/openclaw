import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { resolveHeartbeatDeliveryTargetWithSessionRoute } from "./targets.js";
import { createTestChannelPlugin, createTargetsTestRegistry } from "./targets.test-helpers.js";

const mocks = vi.hoisted(() => ({
  resolveOutboundChannelPlugin: vi.fn(),
}));

vi.mock("./channel-resolution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel-resolution.js")>()),
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

function createNamespacePlugin(options: {
  entries?: Array<{ kind: "group" | "user"; id: string; name: string }>;
  listGroups?: NonNullable<NonNullable<ChannelPlugin["directory"]>["listGroups"]>;
  messaging?: ChannelPlugin["messaging"];
  outbound?: ChannelPlugin["outbound"];
}): ChannelPlugin {
  return {
    ...createTestChannelPlugin({
      id: "alpha",
      label: "Alpha",
      outbound: options.outbound ?? { deliveryMode: "direct" },
      messaging:
        options.messaging ??
        ({
          targetPrefixes: ["a"],
          normalizeTarget: (raw) => {
            const trimmed = raw.trim();
            return trimmed.startsWith("C") ? trimmed : `@${trimmed}`;
          },
          targetResolver: { looksLikeId: () => true, hint: "<channel>" },
        } satisfies NonNullable<ChannelPlugin["messaging"]>),
    }),
    directory: {
      listGroups: options.listGroups ?? vi.fn().mockResolvedValue(options.entries ?? []),
    },
  };
}

async function resolveNamespaceHeartbeat(
  plugin: ChannelPlugin,
  directPolicy?: "allow" | "block",
  target = "alpha",
  to = target,
) {
  setActivePluginRegistry(createTargetsTestRegistry([plugin]));
  mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);
  return await resolveHeartbeatDeliveryTargetWithSessionRoute({
    cfg: { channels: { alpha: {} } } as OpenClawConfig,
    agentId: "main",
    heartbeat: { target, to, directPolicy },
  });
}

describe("outbound channel namespace targets", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    mocks.resolveOutboundChannelPlugin.mockReset();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it.each([
    {
      name: "uses an exact directory destination",
      plugin: createNamespacePlugin({
        entries: [{ kind: "group", id: "C123456", name: "alpha" }],
      }),
      expectedTo: "C123456",
    },
    {
      name: "uses a concrete native namespace resolver without an ID heuristic",
      plugin: createNamespacePlugin({
        messaging: {
          targetPrefixes: ["a"],
          targetResolver: {
            resolveTarget: async () => ({ to: "C123456", kind: "group", source: "normalized" }),
          },
        },
      }),
      expectedTo: "C123456",
    },
    {
      name: "preserves an explicit native destination after a directory miss",
      plugin: createNamespacePlugin({ entries: [] }),
      expectedTo: "@alpha",
    },
    {
      name: "uses a concrete native namespace resolver without a normalizer",
      plugin: createNamespacePlugin({
        messaging: {
          targetPrefixes: ["a"],
          targetResolver: {
            looksLikeId: () => true,
            resolveTarget: async () => ({ to: "C123456", kind: "group", source: "normalized" }),
          },
        },
      }),
      expectedTo: "C123456",
    },
    {
      name: "preserves a native namespace ID without normalization or concrete resolvers",
      plugin: createNamespacePlugin({
        messaging: {
          targetPrefixes: ["a"],
          targetResolver: { looksLikeId: () => true },
        },
      }),
      expectedTo: "alpha",
    },
    {
      name: "preserves provider-classified group handles during initial normalization",
      plugin: createNamespacePlugin({
        messaging: {
          targetPrefixes: ["a"],
          normalizeTarget: (raw) => raw.trim(),
          inferTargetChatType: () => "group",
          targetResolver: { looksLikeId: () => true },
        },
      }),
      to: "@ops",
      directPolicy: "block" as const,
      expectedTo: "@ops",
    },
    {
      name: "preserves provider-classified groups when normalization adds a handle marker",
      plugin: createNamespacePlugin({
        messaging: {
          targetPrefixes: ["a"],
          normalizeTarget: (raw) => (raw.startsWith("@") ? raw : `@${raw}`),
          inferTargetChatType: () => "group",
          targetResolver: { looksLikeId: () => true },
        },
      }),
      to: "ops",
      directPolicy: "block" as const,
      expectedTo: "ops",
    },
    {
      name: "preserves provider-classified native outbound groups",
      plugin: createNamespacePlugin({
        outbound: {
          deliveryMode: "direct",
          resolveTarget: () => ({ ok: true, to: "@ops" }),
        },
        messaging: {
          targetPrefixes: ["a"],
          inferTargetChatType: () => "group",
        },
      }),
      directPolicy: "block" as const,
      expectedTo: "@ops",
    },
    {
      name: "preserves a directory-confirmed group when its handle marker changes",
      plugin: createNamespacePlugin({
        entries: [{ kind: "group", id: "OPS", name: "alpha" }],
        outbound: {
          deliveryMode: "direct",
          resolveTarget: () => ({ ok: true, to: "@OPS" }),
        },
        messaging: { targetPrefixes: ["a"] },
      }),
      directPolicy: "block" as const,
      expectedTo: "@OPS",
    },
    {
      name: "preserves a confirmed group across a provider-prefix rewrite",
      plugin: createNamespacePlugin({
        entries: [{ kind: "group", id: "@ops", name: "alpha" }],
        outbound: {
          deliveryMode: "direct",
          resolveTarget: () => ({ ok: true, to: "alpha:@ops" }),
        },
        messaging: {
          targetPrefixes: ["a"],
          inferTargetChatType: () => "group",
        },
      }),
      directPolicy: "block" as const,
      expectedTo: "alpha:@ops",
    },
    {
      name: "allows a confirmed peer rewritten to an explicitly typed group",
      plugin: createNamespacePlugin({
        entries: [{ kind: "user", id: "D123456", name: "alpha" }],
        outbound: {
          deliveryMode: "direct",
          resolveTarget: () => ({ ok: true, to: "group:C123456" }),
        },
        messaging: {
          targetPrefixes: ["a"],
          inferTargetChatType: () => "group",
        },
      }),
      directPolicy: "block" as const,
      expectedTo: "group:C123456",
    },
  ])("$name", async ({ plugin, expectedTo, directPolicy, to }) => {
    const resolved = await resolveNamespaceHeartbeat(plugin, directPolicy, "alpha", to);

    expect(resolved).toMatchObject({ channel: "alpha", to: expectedTo });
  });

  it("does not resolve a reserved namespace literal through native fallback", async () => {
    const resolveTarget = vi.fn(async () => ({
      to: "C123456",
      kind: "group" as const,
      source: "normalized" as const,
    }));
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        messaging: {
          targetPrefixes: ["a"],
          targetResolver: {
            looksLikeId: () => true,
            reservedLiterals: ["alpha"],
            resolveTarget,
          },
        },
      }),
    );

    expect(resolved).toMatchObject({ channel: "none", reason: "no-target" });
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it("blocks a native outbound namespace rewritten to an explicit direct recipient", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        outbound: {
          deliveryMode: "direct",
          resolveTarget: () => ({ ok: true, to: "user:42" }),
        },
        messaging: {
          targetPrefixes: ["a"],
          inferTargetChatType: () => "group",
        },
      }),
      "block",
    );

    expect(resolved).toMatchObject({ channel: "none", reason: "dm-blocked" });
  });

  it("blocks a confirmed group handle rewritten to a typed peer with the same native ID", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        entries: [{ kind: "group", id: "@ops", name: "alpha" }],
        outbound: {
          deliveryMode: "direct",
          resolveTarget: () => ({ ok: true, to: "user:ops" }),
        },
        messaging: {
          targetPrefixes: ["a"],
          inferTargetChatType: () => "group",
        },
      }),
      "block",
    );

    expect(resolved).toMatchObject({ channel: "none", reason: "dm-blocked" });
  });

  it("keeps a confirmed peer direct through an opaque rewrite with weak group inference", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        entries: [{ kind: "user", id: "D123456", name: "alpha" }],
        outbound: {
          deliveryMode: "direct",
          resolveTarget: () => ({ ok: true, to: "opaque-conversation-id" }),
        },
        messaging: {
          targetPrefixes: ["a"],
          inferTargetChatType: () => "group",
        },
      }),
      "block",
    );

    expect(resolved).toMatchObject({ channel: "none", reason: "dm-blocked" });
  });

  it("blocks a normalized native direct destination after a directory miss", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({ entries: [] }),
      "block",
    );

    expect(resolved).toMatchObject({ channel: "none", reason: "dm-blocked" });
  });

  it("blocks a canonical direct recipient after normalization removes its group wrapper", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        messaging: {
          targetPrefixes: ["a"],
          normalizeTarget: (raw) => raw.replace(/^(?:alpha:)?group:/, ""),
          inferTargetChatType: ({ to }) => (to.includes("group:") ? "group" : "direct"),
          targetResolver: { looksLikeId: () => true },
        },
      }),
      "block",
      "alpha",
      "alpha:group:42",
    );

    expect(resolved).toMatchObject({ channel: "none", reason: "dm-blocked" });
  });

  it("fails closed when namespace directory resolution fails", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        listGroups: vi.fn().mockRejectedValue(new Error("directory unavailable")),
      }),
    );

    expect(resolved).toMatchObject({ channel: "none", reason: "no-target" });
  });

  it("applies heartbeat allow-from policy to an exact directory destination", async () => {
    const resolveTarget = vi.fn(({ to, allowFrom }: { to?: string; allowFrom?: string[] }) =>
      to === "C123456" && allowFrom?.includes("operator")
        ? { ok: false as const, error: new Error("recipient not allowed") }
        : { ok: true as const, to: to ?? "" },
    );
    const plugin = createNamespacePlugin({
      entries: [{ kind: "group", id: "C123456", name: "alpha" }],
      outbound: { deliveryMode: "direct", resolveTarget },
      messaging: { targetPrefixes: ["a"] },
    });
    plugin.config = {
      ...plugin.config,
      resolveAllowFrom: () => ["operator"],
    };

    const resolved = await resolveNamespaceHeartbeat(plugin);

    expect(resolved).toMatchObject({ channel: "none", reason: "no-target" });
    expect(resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ to: "C123456", allowFrom: ["operator"], mode: "heartbeat" }),
    );
  });

  it("fails closed when heartbeat policy rejects an ordinary resolved directory target", async () => {
    const plugin = createNamespacePlugin({
      entries: [{ kind: "group", id: "blocked-room", name: "ops" }],
      messaging: { targetPrefixes: ["a"], targetResolver: { hint: "<channel>" } },
      outbound: {
        deliveryMode: "direct",
        resolveTarget: ({ to }) =>
          to === "blocked-room"
            ? { ok: false, error: new Error("recipient not allowed") }
            : { ok: true, to: to ?? "" },
      },
    });

    const resolved = await resolveNamespaceHeartbeat(plugin, undefined, "ops");

    expect(resolved).toMatchObject({ channel: "none", reason: "no-target" });
  });

  it.each([
    {
      name: "a directory target rewritten to a direct recipient",
      entries: [{ kind: "group" as const, id: "C123456", name: "alpha" }],
      resolveTarget: () => ({ ok: true as const, to: "user:42" }),
      messaging: { targetPrefixes: ["a"] },
    },
    {
      name: "an unchanged direct directory target despite conflicting inference",
      entries: [{ kind: "user" as const, id: "D123456", name: "alpha" }],
      resolveTarget: ({ to }: { to?: string }) => ({ ok: true as const, to: to ?? "" }),
      messaging: {
        targetPrefixes: ["a"],
        inferTargetChatType: (): "group" => "group",
      },
    },
    {
      name: "an equivalent provider-prefixed direct directory target despite conflicting inference",
      entries: [{ kind: "user" as const, id: "D123456", name: "alpha" }],
      resolveTarget: () => ({ ok: true as const, to: "alpha:D123456" }),
      messaging: {
        targetPrefixes: ["a"],
        inferTargetChatType: (): "group" => "group",
      },
    },
    {
      name: "a provider-prefixed group rewritten to a direct recipient",
      entries: [{ kind: "group" as const, id: "alpha:group:42", name: "alpha" }],
      resolveTarget: () => ({ ok: true as const, to: "alpha:user:42" }),
      messaging: {
        targetPrefixes: ["a"],
        normalizeTarget: (raw: string) => raw.trim(),
        inferTargetChatType: (): "group" => "group",
      },
    },
  ])("blocks $name", async ({ entries, resolveTarget, messaging }) => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        entries,
        outbound: { deliveryMode: "direct", resolveTarget },
        messaging,
      }),
      "block",
    );

    expect(resolved).toEqual({ channel: "none", reason: "dm-blocked" });
  });
});
