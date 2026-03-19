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
});
