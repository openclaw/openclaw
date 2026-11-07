import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChannelDirectoryEntry } from "../../channels/plugins/types.public.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { resetDirectoryCache } from "./target-resolver.js";
import { resolveProactiveDeliveryTarget } from "./targets.js";
import { createTestChannelPlugin, createTargetsTestRegistry } from "./targets.test-helpers.js";

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  resetDirectoryCache();
});
afterEach(() => resetPluginRuntimeStateForTest());

it.each(["last", "alpha"])(
  "guards namespace direct delivery with %s channel selection",
  async (target) => {
    const normalizeTarget = vi.fn((raw: string) => `@${raw}`);
    const resolveTarget = vi.fn(({ to }: { to?: string }) => ({ ok: true as const, to: to ?? "" }));
    const plugin = createTestChannelPlugin({
      id: "alpha",
      messaging: { normalizeTarget, targetResolver: { looksLikeId: () => true } },
      outbound: {
        deliveryMode: "direct",
        resolveTarget,
        sendText: async () => ({ channel: "alpha", messageId: "sent-1" }),
      },
    });
    setActivePluginRegistry(createTargetsTestRegistry([plugin]));

    const result = await resolveProactiveDeliveryTarget({
      cfg: {},
      entry: {
        sessionId: "namespace-source",
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({ context: { channel: "alpha", to: "alpha" } }),
      },
      policy: { target, ...(target === "alpha" ? { to: "alpha" } : {}), directPolicy: "block" },
    });

    expect(result).toMatchObject({
      channel: "none",
      reason: target === "last" ? "no-target" : "dm-blocked",
    });
    if (target === "last") {
      expect(normalizeTarget).not.toHaveBeenCalled();
      expect(resolveTarget).not.toHaveBeenCalled();
    }
  },
);

it.each([
  { kind: "group" as const, id: "group:42", rewritten: "group:42", expected: "alpha" },
  { kind: "user" as const, id: "peer-42", rewritten: "peer-42", expected: "dm-blocked" },
  { kind: "group" as const, id: "group:42", rewritten: "42", expected: "dm-blocked" },
  { kind: "group" as const, id: "room-42", rewritten: "opaque-peer", expected: "dm-blocked" },
  { kind: "group" as const, id: "denied-room", rewritten: "denied-room", expected: "no-target" },
  {
    kind: "group" as const,
    id: "alpha:group:42",
    rewritten: "alpha:user:42",
    expected: "dm-blocked",
  },
])(
  "checks namespace $kind/$id → $rewritten against existing delivery policy",
  async ({ kind, id, rewritten, expected }) => {
    const resolveTarget = vi.fn(({ to, allowFrom }: { to?: string; allowFrom?: string[] }) =>
      to === "denied-room" && allowFrom?.includes("operator")
        ? { ok: false as const, error: new Error("recipient not allowed") }
        : { ok: true as const, to: to === id ? rewritten : (to ?? "") },
    );
    const plugin = createTestChannelPlugin({
      id: "alpha",
      messaging: {
        targetPrefixes: ["alpha"],
        inferTargetChatType: ({ to }) =>
          to === "42" ? "direct" : to.startsWith("alpha:") ? "group" : undefined,
      },
      outbound: {
        deliveryMode: "direct",
        resolveTarget,
        sendText: async () => ({ channel: "alpha", messageId: "sent-1" }),
      },
    });
    plugin.directory = {
      listGroups: async () => (kind === "group" ? [{ kind, id, name: "alpha" }] : []),
      listPeers: async () => (kind === "user" ? [{ kind, id, name: "alpha" }] : []),
    };
    plugin.config = { ...plugin.config, resolveAllowFromAsync: async () => ["operator"] };
    setActivePluginRegistry(createTargetsTestRegistry([plugin]));

    const result = await resolveProactiveDeliveryTarget({
      cfg: {},
      policy: { target: "alpha", to: "alpha", directPolicy: "block" },
    });

    expect(result).toMatchObject(
      expected === "alpha"
        ? { channel: "alpha", to: rewritten, chatType: "group" }
        : { channel: "none", reason: expected },
    );
    if (expected === "no-target") {
      expect(resolveTarget).toHaveBeenCalledWith(
        expect.objectContaining({ to: "denied-room", allowFrom: ["operator"], mode: "heartbeat" }),
      );
    }
  },
);

it("fails closed when namespace directory lookup fails", async () => {
  const plugin = createTestChannelPlugin({
    id: "alpha",
    outbound: {
      deliveryMode: "direct",
      sendText: async () => ({ channel: "alpha", messageId: "sent-1" }),
    },
  });
  plugin.directory = {
    listGroups: async (): Promise<ChannelDirectoryEntry[]> => {
      throw new Error("directory unavailable");
    },
  };
  setActivePluginRegistry(createTargetsTestRegistry([plugin]));

  expect(
    await resolveProactiveDeliveryTarget({ cfg: {}, policy: { target: "alpha", to: "alpha" } }),
  ).toMatchObject({ channel: "none", reason: "no-target" });
});
