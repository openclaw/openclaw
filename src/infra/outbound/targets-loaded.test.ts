// Verifies loaded-target resolution uses already-loaded plugins and does not
// trigger channel bootstrap discovery.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { tryResolveLoadedOutboundTarget } from "./targets-loaded.js";

const mocks = vi.hoisted(() => ({
  getLoadedChannelPlugin: vi.fn(),
}));

vi.mock("../../channels/plugins/registry-loaded.js", () => ({
  getLoadedChannelPluginForRead: mocks.getLoadedChannelPlugin,
}));

describe("tryResolveLoadedOutboundTarget", () => {
  beforeEach(() => {
    mocks.getLoadedChannelPlugin.mockReset();
  });

  it("returns undefined when no loaded plugin exists", async () => {
    mocks.getLoadedChannelPlugin.mockReturnValue(undefined);

    expect(
      await tryResolveLoadedOutboundTarget({ channel: "alpha", to: "room-one" }),
    ).toBeUndefined();
  });

  it("uses loaded plugin config defaultTo fallback", async () => {
    const cfg: OpenClawConfig = {
      channels: { alpha: { defaultTo: "room-one" } },
    };
    mocks.getLoadedChannelPlugin.mockReturnValue({
      id: "alpha",
      meta: { label: "Alpha" },
      capabilities: {},
      config: {
        resolveDefaultTo: ({ cfg: cfgLocal }: { cfg: OpenClawConfig }) =>
          (cfgLocal.channels?.alpha as { defaultTo?: string } | undefined)?.defaultTo,
      },
      outbound: {},
      messaging: {},
    });

    expect(
      await tryResolveLoadedOutboundTarget({
        channel: "alpha",
        to: "",
        cfg,
        mode: "implicit",
      }),
    ).toEqual({ ok: true, to: "room-one" });
  });

  it.each([
    { allowFrom: undefined, to: "no-policy-target" },
    { allowFrom: ["allowed-peer"], to: "allowed-peer" },
  ])(
    "uses the asynchronous allowlist owner result $allowFrom without legacy fallback",
    async ({ allowFrom, to }) => {
      const legacy = vi.fn(() => ["stale-peer"]);
      mocks.getLoadedChannelPlugin.mockReturnValue({
        id: "alpha",
        meta: { label: "Alpha" },
        config: {
          resolveAllowFrom: legacy,
          resolveAllowFromAsync: async () => allowFrom,
        },
        outbound: {
          resolveTarget: ({ allowFrom: allowed }: { allowFrom?: string[] }) => ({
            ok: true,
            to: allowed?.[0] ?? "no-policy-target",
          }),
        },
      });

      expect(await tryResolveLoadedOutboundTarget({ channel: "alpha", cfg: {} })).toEqual({
        ok: true,
        to,
      });
      expect(legacy).not.toHaveBeenCalled();
    },
  );

  it("propagates asynchronous allowlist failure before resolving a delivery target", async () => {
    const error = new Error("policy unavailable");
    const legacy = vi.fn(() => ["stale-peer"]);
    const resolveTarget = vi.fn();
    mocks.getLoadedChannelPlugin.mockReturnValue({
      id: "alpha",
      config: {
        resolveAllowFrom: legacy,
        resolveAllowFromAsync: async () => {
          throw error;
        },
      },
      outbound: { resolveTarget },
    });

    await expect(tryResolveLoadedOutboundTarget({ channel: "alpha", cfg: {} })).rejects.toBe(error);
    expect(legacy).not.toHaveBeenCalled();
    expect(resolveTarget).not.toHaveBeenCalled();
  });
});
