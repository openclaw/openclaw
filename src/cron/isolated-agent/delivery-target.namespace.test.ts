import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetDirectoryCache } from "../../infra/outbound/target-resolver.js";
import { buildChannelOutboundSessionRoute } from "../../plugin-sdk/core.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { withTempCronHome } from "../isolated-agent.test-harness.js";
import { resolveDeliveryTarget } from "./delivery-target.js";

afterEach(() => {
  resetDirectoryCache();
  resetPluginRuntimeStateForTest();
});

it("preserves a namespace directory identity through cron session routing", async () => {
  await withTempCronHome(async () => {
    const plugin = createOutboundTestPlugin({
      id: "alpha",
      capabilities: { chatTypes: ["direct", "group"] },
      outbound: {
        deliveryMode: "gateway",
        resolveTarget: ({ to }) => ({ ok: true, to: to ?? "" }),
      },
      messaging: {
        targetResolver: { looksLikeId: (raw) => /^C\d+$/.test(raw) },
        resolveOutboundSessionRoute: ({ cfg, agentId, target, resolvedTarget }) =>
          buildChannelOutboundSessionRoute({
            cfg,
            agentId,
            channel: "alpha",
            peer: { kind: resolvedTarget?.kind === "user" ? "direct" : "channel", id: target },
            chatType: resolvedTarget?.kind === "user" ? "direct" : "channel",
            from: `alpha:${target}`,
            to: `channel:${target.replace(/^channel:/, "")}`,
          }),
      },
    });
    plugin.directory = {
      listGroups: async () => [{ kind: "group", id: "C12345678", name: "alpha" }],
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "alpha", source: "test", plugin }]));

    const result = await resolveDeliveryTarget(
      { channels: { alpha: {} } } as OpenClawConfig,
      "main",
      { channel: "alpha", to: "alpha" },
      { sessionContext: { mainSessionKey: "agent:main:main", usedSharedMainFallback: false } },
    );

    expect(result).toMatchObject({
      ok: true,
      to: "channel:C12345678",
      sessionRoute: { to: "channel:C12345678", peer: { kind: "channel", id: "C12345678" } },
    });
  });
});

it.each([
  { channel: "last", destination: undefined, denied: false, expected: "missing" },
  { channel: "last", destination: "allowed-room", denied: false, expected: "allowed-room" },
  { channel: "last", destination: "denied-room", denied: true, expected: "@operator" },
  {
    channel: "last",
    explicitTo: true,
    destination: "denied-room",
    denied: true,
    expected: "denied",
  },
  { channel: "alpha", destination: "allowed-room", denied: false, expected: "@alpha" },
  {
    channel: "last",
    explicitTo: true,
    noSource: true,
    destination: undefined,
    denied: false,
    expected: "missing",
  },
])(
  "resolves cron namespace with $channel channel ($expected)",
  async ({ channel, explicitTo, noSource, destination, denied, expected }) => {
    await withTempCronHome(async () => {
      const normalizeTarget = vi.fn((raw: string) => (raw.startsWith("@") ? raw : `@${raw}`));
      const resolveTarget = vi.fn(({ to, allowFrom }: { to?: string; allowFrom?: string[] }) =>
        denied && to === "@denied-room" && allowFrom?.includes("operator")
          ? { ok: false as const, error: new Error("cron target denied") }
          : { ok: true as const, to: to ?? "" },
      );
      const plugin = createOutboundTestPlugin({
        id: "alpha",
        outbound: {
          deliveryMode: "direct",
          resolveTarget,
          sendText: async () => ({ channel: "alpha", messageId: "sent-1" }),
        },
        messaging: { normalizeTarget, targetResolver: { looksLikeId: () => true } },
      });
      plugin.config = {
        ...plugin.config,
        listAccountIds: () => ["default"],
        isConfigured: () => true,
        resolveAllowFromAsync: async () => ["operator"],
      };
      plugin.directory = {
        listGroups: async () =>
          destination ? [{ kind: "group", id: destination, name: "alpha" }] : [],
      };
      setActivePluginRegistry(createTestRegistry([{ pluginId: "alpha", source: "test", plugin }]));

      const result = await resolveDeliveryTarget(
        { channels: { alpha: {} } } as OpenClawConfig,
        "main",
        { channel, ...(explicitTo ? { to: "alpha" } : {}) },
        {
          sessionContext: {
            mainSessionKey: "agent:main:main",
            main: {
              sessionId: "cron-namespace-source",
              updatedAt: 1,
              ...(!noSource
                ? {
                    delivery: normalizeSessionDeliveryState({
                      context: { channel: "alpha", to: "alpha" },
                    }),
                  }
                : {}),
            },
            usedSharedMainFallback: false,
          },
        },
      );

      if (expected === "missing" || expected === "denied") {
        expect(result).toMatchObject({
          ok: false,
          error: {
            message: expect.stringContaining(
              expected === "missing" ? "does not specify a destination" : "cron target denied",
            ),
          },
        });
        if (expected === "missing") {
          expect(normalizeTarget).not.toHaveBeenCalled();
          expect(resolveTarget).not.toHaveBeenCalled();
        }
      } else {
        expect(result).toMatchObject({
          ok: true,
          to: expected.startsWith("@") ? expected : `@${expected}`,
        });
      }
    });
  },
);
