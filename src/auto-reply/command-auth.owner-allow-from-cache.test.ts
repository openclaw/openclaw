import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { OpenClawConfig } from "../config/config.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import type { MsgContext } from "./templating.js";

const largeListFormatter = vi.fn();

describe("resolveCommandAuthorization owner allowlist hot path", () => {
  beforeEach(() => {
    largeListFormatter.mockReset();
    const plugin = createOutboundTestPlugin({
      id: "discord",
      outbound: { deliveryMode: "direct" },
    });
    plugin.config = {
      ...plugin.config,
      formatAllowFrom: ({ allowFrom }) => {
        if (allowFrom.length > 1) {
          largeListFormatter();
        }
        return allowFrom
          .map((entry) => String(entry ?? "").trim())
          .filter((entry) => entry.length > 0);
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "discord", plugin, source: "test" }]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("reuses processed ownerAllowFrom for repeated authorizations on the same config snapshot", () => {
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ["123", "456", "789"] },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      From: "discord:123",
      SenderId: "123",
    } as MsgContext;

    resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });
    resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(largeListFormatter).toHaveBeenCalledTimes(1);
  });

  it("does not reuse cached ownerAllowFrom across config snapshots sharing the same array", () => {
    const sharedOwnerAllowFrom = ["123", "456", "789"];
    const cfgA = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: sharedOwnerAllowFrom },
      testVariant: "A",
    } as OpenClawConfig;
    const cfgB = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: sharedOwnerAllowFrom },
      testVariant: "B",
    } as OpenClawConfig;

    const plugin = createOutboundTestPlugin({
      id: "discord",
      outbound: { deliveryMode: "direct" },
    });
    plugin.config = {
      ...plugin.config,
      formatAllowFrom: ({ cfg, allowFrom }) =>
        allowFrom.map((entry) => `${(cfg as { testVariant?: string }).testVariant}:${String(entry)}`),
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "discord", plugin, source: "test" }]),
      "owner-cache-config-a",
    );

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      From: "discord:123",
      SenderId: "123",
    } as MsgContext;

    const authA = resolveCommandAuthorization({
      ctx,
      cfg: cfgA,
      commandAuthorized: true,
    });
    const authB = resolveCommandAuthorization({
      ctx,
      cfg: cfgB,
      commandAuthorized: true,
    });

    expect(authA.ownerList).toEqual(["A:123", "A:456", "A:789"]);
    expect(authB.ownerList).toEqual(["B:123", "B:456", "B:789"]);
  });

  it("does not reuse cached ownerAllowFrom across plugin registry reloads", () => {
    const sharedOwnerAllowFrom = ["123", "456", "789"];
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: sharedOwnerAllowFrom },
    } as OpenClawConfig;
    const ctx = {
      Provider: "discord",
      Surface: "discord",
      From: "discord:123",
      SenderId: "123",
    } as MsgContext;

    const pluginA = createOutboundTestPlugin({
      id: "discord",
      outbound: { deliveryMode: "direct" },
    });
    pluginA.config = {
      ...pluginA.config,
      formatAllowFrom: ({ allowFrom }) => allowFrom.map((entry) => `A:${String(entry)}`),
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "discord", plugin: pluginA, source: "test" }]),
      "owner-cache-registry-a",
    );
    const authA = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    const pluginB = createOutboundTestPlugin({
      id: "discord",
      outbound: { deliveryMode: "direct" },
    });
    pluginB.config = {
      ...pluginB.config,
      formatAllowFrom: ({ allowFrom }) => allowFrom.map((entry) => `B:${String(entry)}`),
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "discord", plugin: pluginB, source: "test" }]),
      "owner-cache-registry-b",
    );
    const authB = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(authA.ownerList).toEqual(["A:123", "A:456", "A:789"]);
    expect(authB.ownerList).toEqual(["B:123", "B:456", "B:789"]);
  });
});
