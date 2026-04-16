import { describe, expect, it } from "vitest";
import type { AgentRouteBinding } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveFirstBoundAccountId } from "./bound-account-read.js";

function cfgWithBindings(bindings: AgentRouteBinding[]): OpenClawConfig {
  return { bindings } as unknown as OpenClawConfig;
}

describe("resolveFirstBoundAccountId", () => {
  it("returns exact peer match when caller supplies a matching peerId", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: { channel: "matrix", accountId: "bot-alpha-default" },
      },
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "channel", id: "!roomA:example.org" },
          accountId: "bot-alpha-room-a",
        },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
        peerId: "!roomA:example.org",
      }),
    ).toBe("bot-alpha-room-a");
  });

  it("prefers wildcard peer binding over channel-only when caller peerKind matches", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: { channel: "matrix", accountId: "bot-alpha-default" },
      },
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "channel", id: "*" },
          accountId: "bot-alpha-wildcard",
        },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
        peerId: "!anyRoom:example.org",
        peerKind: "channel",
      }),
    ).toBe("bot-alpha-wildcard");
  });

  it("prefers channel-only over wildcard peer binding when caller supplies no peerId", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "channel", id: "*" },
          accountId: "bot-alpha-wildcard",
        },
      },
      {
        type: "route",
        agentId: "bot-alpha",
        match: { channel: "matrix", accountId: "bot-alpha-default" },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
      }),
    ).toBe("bot-alpha-default");
  });

  it("falls back to peer-specific binding for peerless callers when no channel-only or wildcard binding exists", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "channel", id: "!specificRoom:example.org" },
          accountId: "bot-alpha-specific",
        },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
      }),
    ).toBe("bot-alpha-specific");
  });

  it("skips non-matching peer-specific bindings when caller supplies a different peerId", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "channel", id: "!otherRoom:example.org" },
          accountId: "bot-alpha-other",
        },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
        peerId: "!differentRoom:example.org",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the agent has no binding on the channel", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: { channel: "whatsapp", accountId: "bot-alpha-whatsapp" },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
      }),
    ).toBeUndefined();
  });

  it("filters bindings by peer kind when caller supplies peerKind", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "direct", id: "*" },
          accountId: "bot-alpha-dm",
        },
      },
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "channel", id: "*" },
          accountId: "bot-alpha-room",
        },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
        peerId: "!room:example.org",
        peerKind: "channel",
      }),
    ).toBe("bot-alpha-room");
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
        peerId: "@user:example.org",
        peerKind: "direct",
      }),
    ).toBe("bot-alpha-dm");
  });

  it("skips wildcard peer bindings when the caller's peerKind is unknown", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "direct", id: "*" },
          accountId: "bot-alpha-dm",
        },
      },
      {
        type: "route",
        agentId: "bot-alpha",
        match: { channel: "matrix", accountId: "bot-alpha-default" },
      },
    ]);
    // Without a peerKind on the caller, we cannot verify kind compatibility
    // for the wildcard binding — it must be skipped in favor of the channel-only
    // fallback rather than risk routing to the wrong identity.
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
        peerId: "!room:example.org",
      }),
    ).toBe("bot-alpha-default");
  });

  it("matches exact peer id even when the caller's peerKind is unknown", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "channel", id: "!room:example.org" },
          accountId: "bot-alpha-room",
        },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
        peerId: "!room:example.org",
      }),
    ).toBe("bot-alpha-room");
  });

  it("skips peer-specific bindings whose kind does not match the caller's peerKind", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "direct", id: "!room:example.org" },
          accountId: "bot-alpha-wrong-kind",
        },
      },
      {
        type: "route",
        agentId: "bot-alpha",
        match: { channel: "matrix", accountId: "bot-alpha-default" },
      },
    ]);
    // Caller peerKind=channel: the direct-kind binding is ineligible even though
    // its peerId would match — falls through to the channel-only binding.
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
        peerId: "!room:example.org",
        peerKind: "channel",
      }),
    ).toBe("bot-alpha-default");
  });
});
