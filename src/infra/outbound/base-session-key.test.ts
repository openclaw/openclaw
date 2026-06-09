// Verifies outbound base-session keys honor per-binding session-scope
// overrides so outbound-only sends resolve to the same session as inbound.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildOutboundBaseSessionKey } from "./base-session-key.js";

describe("buildOutboundBaseSessionKey per-binding session scope", () => {
  it("folds a group into main via a per-binding groupScope override against a per-group default", () => {
    const cfg: OpenClawConfig = {
      session: { groupScope: "per-group" },
      bindings: [
        {
          type: "route",
          agentId: "main",
          match: {
            channel: "telegram",
            accountId: "default",
            peer: { kind: "group", id: "-100folded" },
          },
          session: { groupScope: "main" },
        },
      ],
    };

    // Bound group folds into main per its override.
    expect(
      buildOutboundBaseSessionKey({
        cfg,
        agentId: "main",
        channel: "telegram",
        accountId: "default",
        peer: { kind: "group", id: "-100folded" },
      }),
    ).toBe("agent:main:main");

    // Other groups keep their own key under the per-group default.
    expect(
      buildOutboundBaseSessionKey({
        cfg,
        agentId: "main",
        channel: "telegram",
        accountId: "default",
        peer: { kind: "group", id: "-100other" },
      }),
    ).toBe("agent:main:telegram:group:-100other");
  });

  it("keeps a group on its own key via a per-binding groupScope override against a main default", () => {
    const cfg: OpenClawConfig = {
      session: { groupScope: "main" },
      bindings: [
        {
          type: "route",
          agentId: "main",
          match: {
            channel: "telegram",
            accountId: "default",
            peer: { kind: "group", id: "-100separate" },
          },
          session: { groupScope: "per-group" },
        },
      ],
    };

    // Bound group stays on its own key per its override.
    expect(
      buildOutboundBaseSessionKey({
        cfg,
        agentId: "main",
        channel: "telegram",
        accountId: "default",
        peer: { kind: "group", id: "-100separate" },
      }),
    ).toBe("agent:main:telegram:group:-100separate");

    // Other groups fold into main under the global default.
    expect(
      buildOutboundBaseSessionKey({
        cfg,
        agentId: "main",
        channel: "telegram",
        accountId: "default",
        peer: { kind: "group", id: "-100other" },
      }),
    ).toBe("agent:main:main");
  });

  it("honors a per-binding dmScope override for a direct peer", () => {
    const cfg: OpenClawConfig = {
      session: { dmScope: "main" },
      bindings: [
        {
          type: "route",
          agentId: "main",
          match: {
            channel: "telegram",
            accountId: "default",
            peer: { kind: "direct", id: "123" },
          },
          session: { dmScope: "per-channel-peer" },
        },
      ],
    };

    // Bound DM peer keeps its own per-channel-peer key per its override.
    expect(
      buildOutboundBaseSessionKey({
        cfg,
        agentId: "main",
        channel: "telegram",
        accountId: "default",
        peer: { kind: "direct", id: "123" },
      }),
    ).toBe("agent:main:telegram:direct:123");

    // Other DM peers fold into main under the global default.
    expect(
      buildOutboundBaseSessionKey({
        cfg,
        agentId: "main",
        channel: "telegram",
        accountId: "default",
        peer: { kind: "direct", id: "999" },
      }),
    ).toBe("agent:main:main");
  });

  it("falls back to global session scope when no binding matches", () => {
    const perGroupCfg: OpenClawConfig = { session: { groupScope: "per-group" } };
    expect(
      buildOutboundBaseSessionKey({
        cfg: perGroupCfg,
        agentId: "main",
        channel: "telegram",
        accountId: "default",
        peer: { kind: "group", id: "-100plain" },
      }),
    ).toBe("agent:main:telegram:group:-100plain");

    const mainCfg: OpenClawConfig = { session: { groupScope: "main" } };
    expect(
      buildOutboundBaseSessionKey({
        cfg: mainCfg,
        agentId: "main",
        channel: "telegram",
        accountId: "default",
        peer: { kind: "group", id: "-100plain" },
      }),
    ).toBe("agent:main:main");

    // Preserves the caller's explicit agentId rather than the binding's agent.
    expect(
      buildOutboundBaseSessionKey({
        cfg: perGroupCfg,
        agentId: "scribe",
        channel: "telegram",
        accountId: "default",
        peer: { kind: "group", id: "-100plain" },
      }),
    ).toBe("agent:scribe:telegram:group:-100plain");
  });
});
