import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { resolveHeartbeatDeliveryTarget } from "./targets.js";
import { createTestChannelPlugin, createTargetsTestRegistry } from "./targets.test-helpers.js";

const mocks = vi.hoisted(() => ({
  resolveOutboundChannelPlugin: vi.fn(),
}));

vi.mock("./channel-resolution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel-resolution.js")>()),
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

type NamespacePluginOptions = {
  listGroups: NonNullable<NonNullable<ChannelPlugin["directory"]>["listGroups"]>;
  messaging?: ChannelPlugin["messaging"];
  outbound?: ChannelPlugin["outbound"];
};

function createNamespacePlugin(options: NamespacePluginOptions): ChannelPlugin {
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
          resolveOutboundSessionRoute: ({ target }) => ({
            sessionKey: `main:alpha:group:${target}`,
            baseSessionKey: `main:alpha:group:${target}`,
            peer: { kind: "group", id: target },
            chatType: "group",
            from: `alpha:group:${target}`,
            to: target,
          }),
        } satisfies NonNullable<ChannelPlugin["messaging"]>),
    }),
    directory: { listGroups: options.listGroups },
  };
}

async function resolveNamespaceHeartbeat(plugin: ChannelPlugin, directPolicy?: "allow" | "block") {
  setActivePluginRegistry(createTargetsTestRegistry([plugin]));
  mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);
  return await resolveHeartbeatDeliveryTarget({
    cfg: { channels: { alpha: {} } } as OpenClawConfig,
    agentId: "main",
    heartbeat: { target: "alpha", to: "alpha", directPolicy },
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

  it("preserves exact heartbeat directory destinations before rejecting channel namespaces", async () => {
    const listGroups = vi.fn().mockResolvedValue([{ kind: "group", id: "C123456", name: "alpha" }]);
    const resolved = await resolveNamespaceHeartbeat(createNamespacePlugin({ listGroups }));

    expect(resolved).toMatchObject({ channel: "alpha", to: "C123456" });
    expect(listGroups).toHaveBeenCalledWith(expect.objectContaining({ query: "alpha" }));
  });

  it("preserves an explicit heartbeat namespace after a directory miss", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({ listGroups: vi.fn().mockResolvedValue([]) }),
    );

    expect(resolved).toMatchObject({ channel: "alpha", to: "@alpha" });
  });

  it("fails closed when heartbeat namespace directory lookup throws", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        listGroups: vi.fn().mockRejectedValue(new Error("directory unavailable")),
      }),
    );

    expect(resolved).toMatchObject({ channel: "none", reason: "no-target" });
  });

  it("fails closed when heartbeat namespace directory matches are ambiguous", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        listGroups: vi.fn().mockResolvedValue([
          { kind: "group", id: "C1", name: "alpha" },
          { kind: "group", id: "C2", name: "alpha" },
        ]),
      }),
    );

    expect(resolved).toMatchObject({ channel: "none", reason: "no-target" });
  });

  it.each([
    {
      name: "preserves an outbound-resolver target after a miss",
      entries: [],
      expected: { channel: "alpha", to: "@alpha" },
      outboundCalls: 1,
    },
    {
      name: "uses an exact directory destination",
      entries: [{ kind: "group", id: "C123456", name: "alpha" }],
      expected: { channel: "alpha", to: "C123456" },
      outboundCalls: 1,
    },
  ])(
    "validates heartbeat namespaces without optional messaging hooks: $name",
    async ({ entries, expected, outboundCalls }) => {
      const outboundResolveTarget = vi.fn(({ to }: { to?: string }) => ({
        ok: true as const,
        to: to === "alpha" ? "@alpha" : (to ?? ""),
      }));
      const resolved = await resolveNamespaceHeartbeat(
        createNamespacePlugin({
          listGroups: vi.fn().mockResolvedValue(entries),
          outbound: { deliveryMode: "direct", resolveTarget: outboundResolveTarget },
          messaging: { targetPrefixes: ["a"] },
        }),
      );

      expect(resolved).toMatchObject(expected);
      expect(outboundResolveTarget).toHaveBeenCalledTimes(outboundCalls);
    },
  );

  it("carries an exact directory target without a session-route hook", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        listGroups: vi.fn().mockResolvedValue([{ kind: "group", id: "C123456", name: "alpha" }]),
        messaging: {
          targetPrefixes: ["a"],
          targetResolver: { hint: "<channel>" },
        },
      }),
    );

    expect(resolved).toMatchObject({ channel: "alpha", to: "C123456" });
  });

  it("uses the exact directory entry kind for heartbeat direct policy", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        listGroups: vi.fn().mockResolvedValue([{ kind: "group", id: "C123456", name: "alpha" }]),
        messaging: {
          targetPrefixes: ["a"],
          targetResolver: { hint: "<channel>" },
        },
      }),
      "block",
    );

    expect(resolved).toMatchObject({ channel: "alpha", to: "C123456" });
  });

  it("reclassifies a prefix-changing outbound policy rewrite", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        listGroups: vi.fn().mockResolvedValue([{ kind: "group", id: "C123456", name: "alpha" }]),
        outbound: {
          deliveryMode: "direct",
          resolveTarget: () => ({ ok: true, to: "@C123456" }),
        },
        messaging: { targetPrefixes: ["a"] },
      }),
      "block",
    );

    expect(resolved).toEqual({ channel: "none", reason: "dm-blocked" });
  });

  it("keeps an exact directory target when session-route refinement fails", async () => {
    const plugin = createNamespacePlugin({
      listGroups: vi.fn().mockResolvedValue([{ kind: "group", id: "C123456", name: "alpha" }]),
    });
    plugin.messaging = {
      ...plugin.messaging,
      resolveOutboundSessionRoute: () => null,
    };

    const resolved = await resolveNamespaceHeartbeat(plugin);

    expect(resolved).toMatchObject({ channel: "alpha", to: "C123456" });
  });

  it("carries heartbeat allow-from policy through namespace resolution", async () => {
    const resolveTarget = vi.fn(({ allowFrom }: { allowFrom?: string[] }) =>
      allowFrom?.includes("operator")
        ? { ok: true as const, to: "@alpha" }
        : { ok: false as const, error: new Error("recipient not allowed") },
    );
    const plugin = createNamespacePlugin({
      listGroups: vi.fn().mockResolvedValue([]),
      outbound: { deliveryMode: "direct", resolveTarget },
      messaging: { targetPrefixes: ["a"] },
    });
    plugin.config = {
      ...plugin.config,
      resolveAllowFrom: () => ["operator"],
    };

    const resolved = await resolveNamespaceHeartbeat(plugin);

    expect(resolved).toMatchObject({ channel: "alpha", to: "@alpha" });
    expect(resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ allowFrom: ["operator"] }),
    );
  });

  it("applies heartbeat allow-from policy after native namespace resolution", async () => {
    const resolveTarget = vi.fn(({ to, allowFrom }: { to?: string; allowFrom?: string[] }) =>
      to === "@alpha" && allowFrom?.includes("operator")
        ? { ok: false as const, error: new Error("recipient not allowed") }
        : { ok: true as const, to: to ?? "" },
    );
    const plugin = createNamespacePlugin({
      listGroups: vi.fn().mockResolvedValue([]),
      outbound: { deliveryMode: "direct", resolveTarget },
      messaging: {
        targetPrefixes: ["a"],
        normalizeTarget: (raw) => `@${raw.trim()}`,
        targetResolver: {
          looksLikeId: () => true,
          resolveTarget: async ({ normalized }) => ({
            to: normalized,
            kind: "group",
            source: "normalized",
          }),
        },
      },
    });
    plugin.config = {
      ...plugin.config,
      resolveAllowFrom: () => ["operator"],
    };

    const resolved = await resolveNamespaceHeartbeat(plugin);

    expect(resolved).toMatchObject({ channel: "none", reason: "no-target" });
    expect(resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ to: "@alpha", allowFrom: ["operator"], mode: "heartbeat" }),
    );
  });

  it("applies heartbeat allow-from policy to exact directory targets", async () => {
    const resolveTarget = vi.fn(({ to, allowFrom }: { to?: string; allowFrom?: string[] }) =>
      to === "C123456" && allowFrom?.includes("operator")
        ? { ok: false as const, error: new Error("recipient not allowed") }
        : { ok: true as const, to: to ?? "" },
    );
    const plugin = createNamespacePlugin({
      listGroups: vi.fn().mockResolvedValue([{ kind: "group", id: "C123456", name: "alpha" }]),
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

  it("reclassifies an exact directory target rewritten by heartbeat policy", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        listGroups: vi.fn().mockResolvedValue([{ kind: "group", id: "C123456", name: "alpha" }]),
        outbound: {
          deliveryMode: "direct",
          resolveTarget: () => ({ ok: true, to: "user:42" }),
        },
        messaging: {
          targetPrefixes: ["a"],
          inferTargetChatType: ({ to }) => (to.startsWith("user:") ? "direct" : "group"),
        },
      }),
      "block",
    );

    expect(resolved).toMatchObject({ channel: "none", reason: "dm-blocked" });
  });

  it("preserves an unchanged exact directory kind over conflicting inference", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        listGroups: vi.fn().mockResolvedValue([{ kind: "user", id: "D123456", name: "alpha" }]),
        outbound: {
          deliveryMode: "direct",
          resolveTarget: ({ to }) => ({ ok: true, to: to ?? "" }),
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

  it("honors a semantic type change when heartbeat policy preserves the directory ID", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        listGroups: vi.fn().mockResolvedValue([{ kind: "group", id: "C123456", name: "alpha" }]),
        outbound: {
          deliveryMode: "direct",
          resolveTarget: () => ({ ok: true, to: "user:C123456" }),
        },
        messaging: { targetPrefixes: ["a"] },
      }),
      "block",
    );

    expect(resolved).toMatchObject({ channel: "none", reason: "dm-blocked" });
  });

  it("reclassifies a native target rewritten by heartbeat policy", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        listGroups: vi.fn().mockResolvedValue([]),
        outbound: {
          deliveryMode: "direct",
          resolveTarget: () => ({ ok: true, to: "user:42" }),
        },
        messaging: {
          targetPrefixes: ["a"],
          normalizeTarget: (raw) => `@${raw.trim()}`,
          targetResolver: {
            looksLikeId: () => true,
            resolveTarget: async ({ normalized }) => ({
              to: normalized,
              kind: "group",
              source: "normalized",
            }),
          },
        },
      }),
      "block",
    );

    expect(resolved).toMatchObject({ channel: "none", reason: "dm-blocked" });
  });

  it("applies heartbeat direct policy to outbound-resolved namespace targets", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        listGroups: vi.fn().mockResolvedValue([]),
        outbound: {
          deliveryMode: "direct",
          resolveTarget: () => ({ ok: true, to: "@alpha" }),
        },
        messaging: { targetPrefixes: ["a"] },
      }),
      "block",
    );

    expect(resolved).toMatchObject({ channel: "none", reason: "dm-blocked" });
  });

  it("preserves an explicit plugin-native heartbeat destination after a directory miss", async () => {
    const listGroups = vi.fn().mockResolvedValue([]);
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({
        listGroups,
        messaging: {
          targetPrefixes: ["a"],
          normalizeTarget: (raw) => raw.trim(),
          targetResolver: { looksLikeId: () => true, hint: "<nick>" },
        },
      }),
    );

    expect(resolved).toMatchObject({ channel: "alpha", to: "alpha" });
    expect(listGroups).toHaveBeenCalledWith(expect.objectContaining({ query: "alpha" }));
  });
});
