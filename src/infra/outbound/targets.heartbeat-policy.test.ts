import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { resolveHeartbeatDeliveryTarget } from "./targets.js";
import { createTestChannelPlugin, createTargetsTestRegistry } from "./targets.test-helpers.js";

const mocks = vi.hoisted(() => ({
  resolveOutboundChannelPlugin: vi.fn(),
}));

vi.mock("./channel-resolution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel-resolution.js")>()),
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

describe("heartbeat target policy", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    mocks.resolveOutboundChannelPlugin.mockReset();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("does not replace an outbound-approved target without a session route", async () => {
    const plugin: ChannelPlugin = createTestChannelPlugin({
      id: "external-channel",
      label: "External",
      outbound: {
        deliveryMode: "direct",
        resolveTarget: ({ to }) =>
          to === "approved-target"
            ? { ok: true, to }
            : { ok: false, error: new Error("recipient not allowed") },
      },
      messaging: {
        targetResolver: {
          resolveTarget: async () => ({
            to: "unapproved-target",
            kind: "group",
            source: "directory",
          }),
        },
      },
    });
    setActivePluginRegistry(createTargetsTestRegistry([plugin]));
    mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);

    const resolved = await resolveHeartbeatDeliveryTarget({
      cfg: {},
      agentId: "main",
      heartbeat: {
        target: "external-channel",
        to: "approved-target",
      },
    });

    expect(resolved).toMatchObject({ channel: "external-channel", to: "approved-target" });
  });

  it("rejects a native namespace inherited from the last heartbeat route", async () => {
    const plugin: ChannelPlugin = createTestChannelPlugin({
      id: "external-channel",
      label: "External",
      outbound: { deliveryMode: "direct" },
      messaging: {
        normalizeTarget: (raw) => `@${raw.trim()}`,
        targetResolver: { looksLikeId: () => true },
      },
    });
    setActivePluginRegistry(createTargetsTestRegistry([plugin]));
    mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);

    const resolved = await resolveHeartbeatDeliveryTarget({
      cfg: {},
      agentId: "main",
      entry: {
        sessionId: "last-route",
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "external-channel", to: "external-channel" },
        }),
      },
      heartbeat: { target: "last" },
    });

    expect(resolved).toMatchObject({ channel: "none", reason: "no-target" });
  });
});
