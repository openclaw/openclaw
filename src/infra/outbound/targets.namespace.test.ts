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
) {
  setActivePluginRegistry(createTargetsTestRegistry([plugin]));
  mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);
  return await resolveHeartbeatDeliveryTargetWithSessionRoute({
    cfg: { channels: { alpha: {} } } as OpenClawConfig,
    agentId: "main",
    heartbeat: { target, to: target, directPolicy },
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
      name: "preserves an explicit native destination after a directory miss",
      plugin: createNamespacePlugin({ entries: [] }),
      expectedTo: "@alpha",
    },
  ])("$name", async ({ plugin, expectedTo }) => {
    const resolved = await resolveNamespaceHeartbeat(plugin);

    expect(resolved).toMatchObject({ channel: "alpha", to: expectedTo });
  });

  it("blocks a normalized native direct destination after a directory miss", async () => {
    const resolved = await resolveNamespaceHeartbeat(
      createNamespacePlugin({ entries: [] }),
      "block",
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
