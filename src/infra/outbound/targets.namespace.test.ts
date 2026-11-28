import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDirectOutboundTestAdapter } from "../../test-utils/channel-plugins.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { resolveOutboundTarget, resolveProactiveDeliveryTarget } from "./targets.js";
import {
  createGenericTargetTestPlugin,
  createTargetsTestRegistry,
} from "./targets.test-helpers.js";

let plugin: ChannelPlugin;
beforeEach(() => {
  resetPluginRuntimeStateForTest();
  plugin = createGenericTargetTestPlugin("alpha");
  setActivePluginRegistry(createTargetsTestRegistry([plugin]));
});
afterEach(() => resetPluginRuntimeStateForTest());

it.each([
  ["alpha", "alpha"],
  ["@alpha", "@alpha"],
  ["alpha:@alpha", "@alpha"],
  ["alpha:@current", "@current"],
  ["alpha:123456789", "123456789"],
  ["conversation:ref-1", "conversation:ref-1"],
])("preserves explicit destination %s", async (to, expected) => {
  expect(await resolveOutboundTarget({ channel: "alpha", to, mode: "explicit" })).toMatchObject({
    ok: true,
    to: expected,
  });
});

it("keeps a channel-configured default destination explicit", async () => {
  plugin.config.resolveDefaultTo = () => "alpha";
  expect(
    await resolveOutboundTarget({ cfg: {}, channel: "alpha", channelInferred: true }),
  ).toMatchObject({
    ok: true,
    to: "alpha",
  });
});

it.each([
  { target: "last", explicitTo: false },
  { target: "alpha", explicitTo: true },
  { target: "last", explicitTo: true },
])(
  "guards only inferred namespace delivery ($target, explicitTo=$explicitTo)",
  async ({ target, explicitTo }) => {
    const normalizeTarget = vi.fn((raw: string) => `@${raw}`);
    const resolveTarget = vi.fn(({ to }: { to?: string }) => ({ ok: true as const, to: to ?? "" }));
    const listGroups = vi.fn(async () => [
      { kind: "group" as const, id: "real-room", name: "alpha" },
    ]);
    const listPeers = vi.fn(async () => []);
    plugin.messaging = { normalizeTarget, targetResolver: { looksLikeId: () => true } };
    plugin.outbound = createDirectOutboundTestAdapter({ channel: "alpha", resolveTarget });
    plugin.directory = { listGroups, listPeers };
    const result = await resolveProactiveDeliveryTarget({
      cfg: {},
      entry: {
        sessionId: "namespace-source",
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({ context: { channel: "alpha", to: "alpha" } }),
      },
      policy: { target, ...(explicitTo ? { to: "alpha" } : {}) },
    });

    expect(result).toMatchObject(
      explicitTo ? { channel: "alpha", to: "alpha" } : { channel: "none", reason: "no-target" },
    );
    if (!explicitTo) {
      expect(normalizeTarget).not.toHaveBeenCalled();
      expect(resolveTarget).not.toHaveBeenCalled();
    }
    expect(listGroups).not.toHaveBeenCalled();
    expect(listPeers).not.toHaveBeenCalled();
  },
);
