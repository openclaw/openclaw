import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { tryResolveLoadedOutboundTarget as resolve } from "./targets-loaded.js";

const mocks = vi.hoisted(() => ({ getLoadedChannelPlugin: vi.fn() }));

vi.mock("../../channels/plugins/registry-loaded.js", () => ({
  getLoadedChannelPluginForRead: mocks.getLoadedChannelPlugin,
}));

describe("tryResolveLoadedOutboundTarget", () => {
  const config = {
    resolveAllowFrom: vi.fn(() => ["stale-peer"]),
    resolveAllowFromAsync: vi.fn<() => Promise<string[] | undefined>>(),
  };
  beforeEach(() => {
    mocks.getLoadedChannelPlugin.mockReset();
    config.resolveAllowFrom.mockClear();
    config.resolveAllowFromAsync.mockReset();
  });

  it("returns undefined when no loaded plugin exists", async () => {
    expect(await resolve({ channel: "alpha", to: "room-one" })).toBeUndefined();
  });

  it("uses loaded plugin config defaultTo fallback", async () => {
    const cfg: OpenClawConfig = { channels: { alpha: { defaultTo: "room-one" } } };
    mocks.getLoadedChannelPlugin.mockReturnValue({
      id: "alpha",
      meta: { label: "Alpha" },
      config: {
        resolveDefaultTo: ({ cfg: cfgLocal }: { cfg: OpenClawConfig }) =>
          (cfgLocal.channels?.alpha as { defaultTo?: string } | undefined)?.defaultTo,
      },
    });
    expect(await resolve({ channel: "alpha", to: "", cfg, mode: "implicit" })).toEqual({
      ok: true,
      to: "room-one",
    });
  });

  it.each([
    { allowFrom: undefined, to: "no-policy-target" },
    { allowFrom: ["allowed-peer"], to: "allowed-peer" },
  ])("uses async allowlist $allowFrom without legacy fallback", async ({ allowFrom, to }) => {
    config.resolveAllowFromAsync.mockResolvedValue(allowFrom);
    mocks.getLoadedChannelPlugin.mockReturnValue({
      id: "alpha",
      meta: { label: "Alpha" },
      config,
      outbound: {
        resolveTarget: ({ allowFrom: allowed }: { allowFrom?: string[] }) => ({
          ok: true,
          to: allowed?.[0] ?? "no-policy-target",
        }),
      },
    });

    expect(await resolve({ channel: "alpha", cfg: {} })).toEqual({ ok: true, to });
    expect(config.resolveAllowFrom).not.toHaveBeenCalled();
  });

  it("propagates asynchronous allowlist failure before resolving a delivery target", async () => {
    const error = new Error("policy unavailable");
    config.resolveAllowFromAsync.mockRejectedValue(error);
    const resolveTarget = vi.fn();
    mocks.getLoadedChannelPlugin.mockReturnValue({
      id: "alpha",
      config,
      outbound: { resolveTarget },
    });

    await expect(resolve({ channel: "alpha", cfg: {} })).rejects.toBe(error);
    expect(config.resolveAllowFrom).not.toHaveBeenCalled();
    expect(resolveTarget).not.toHaveBeenCalled();
  });
});
