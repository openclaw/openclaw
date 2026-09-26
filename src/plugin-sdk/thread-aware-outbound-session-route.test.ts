/**
 * Tests thread-aware outbound session route helpers exposed by the SDK.
 */
import { describe, expect, it } from "vitest";
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  recoverCurrentThreadSessionId,
  type ChannelOutboundSessionRoute,
} from "./core.js";

function baseRoute(
  overrides: Partial<ChannelOutboundSessionRoute> = {},
): ChannelOutboundSessionRoute {
  return {
    sessionKey: "agent:main:workspace:channel:c123",
    baseSessionKey: "agent:main:workspace:channel:c123",
    peer: { kind: "channel", id: "c123" },
    chatType: "channel",
    from: "workspace:channel:c123",
    to: "channel:c123",
    ...overrides,
  };
}

describe("buildChannelOutboundSessionRoute", () => {
  it("honors groupScope main while retaining the native group address", () => {
    const route = buildChannelOutboundSessionRoute({
      cfg: { session: { groupScope: "main" } },
      agentId: "main",
      channel: "route-fixture",
      peer: { kind: "group", id: "NativeRoom" },
      chatType: "group",
      from: "route-fixture:NativeRoom",
      to: "room:NativeRoom",
    });

    expect(route).toEqual({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
      peer: { kind: "group", id: "NativeRoom" },
      chatType: "group",
      from: "route-fixture:NativeRoom",
      to: "room:NativeRoom",
    });
  });

  it("uses identity links for per-peer keys without rewriting the native peer", () => {
    const route = buildChannelOutboundSessionRoute({
      cfg: {
        session: {
          dmScope: "per-peer",
          identityLinks: { alice: ["route-fixture:123"] },
        },
      },
      agentId: "worker",
      channel: "route-fixture",
      peer: { kind: "direct", id: "123" },
      chatType: "direct",
      from: "route-fixture:123",
      to: "user:123",
    });

    expect(route).toEqual({
      sessionKey: "agent:worker:direct:alice",
      baseSessionKey: "agent:worker:direct:alice",
      peer: { kind: "direct", id: "123" },
      chatType: "direct",
      from: "route-fixture:123",
      to: "user:123",
    });
  });

  it.each([
    { accountId: "blue", expectedKey: "agent:worker:route-fixture:blue:direct:alice" },
    { accountId: "green", expectedKey: "agent:worker:route-fixture:green:direct:alice" },
  ])("partitions the same direct peer by account $accountId", ({ accountId, expectedKey }) => {
    const route = buildChannelOutboundSessionRoute({
      cfg: { session: { dmScope: "per-account-channel-peer" } },
      agentId: "worker",
      channel: "route-fixture",
      accountId,
      peer: { kind: "direct", id: "alice" },
      chatType: "direct",
      from: "route-fixture:alice",
      to: "user:alice",
    });

    expect(route).toEqual({
      sessionKey: expectedKey,
      baseSessionKey: expectedKey,
      peer: { kind: "direct", id: "alice" },
      chatType: "direct",
      from: "route-fixture:alice",
      to: "user:alice",
    });
  });

  it.each([
    {
      name: "omitted metadata",
      recipientSessionExact: undefined,
      threadId: undefined,
      expected: {},
    },
    {
      name: "inexact route with a zero delivery thread",
      recipientSessionExact: false,
      threadId: 0,
      expected: { recipientSessionExact: false, threadId: 0 },
    },
    {
      name: "exact route with a numeric delivery thread",
      recipientSessionExact: true,
      threadId: 99,
      expected: { recipientSessionExact: true, threadId: 99 },
    },
    {
      name: "direct alias with an opaque delivery thread",
      recipientSessionExact: "direct-alias",
      threadId: "$Root:Example.Org",
      expected: { recipientSessionExact: "direct-alias", threadId: "$Root:Example.Org" },
    },
    {
      name: "delivery identity with a case-sensitive delivery thread",
      recipientSessionExact: "delivery-identity",
      threadId: "PluginThread",
      expected: { recipientSessionExact: "delivery-identity", threadId: "PluginThread" },
    },
  ] as const)(
    "preserves $name without adding a session suffix",
    ({ recipientSessionExact, threadId, expected }) => {
      const route = buildChannelOutboundSessionRoute({
        cfg: {},
        agentId: "worker",
        channel: "route-fixture",
        recipientSessionExact,
        threadId,
        peer: { kind: "channel", id: "room" },
        chatType: "channel",
        from: "route-fixture:room",
        to: "channel:room",
      });

      expect(route).toStrictEqual({
        sessionKey: "agent:worker:route-fixture:channel:room",
        baseSessionKey: "agent:worker:route-fixture:channel:room",
        peer: { kind: "channel", id: "room" },
        chatType: "channel",
        from: "route-fixture:room",
        to: "channel:room",
        ...expected,
      });
    },
  );
});

describe("buildThreadAwareOutboundSessionRoute", () => {
  it("uses replyToId before threadId and recovered current-session thread by default", () => {
    const route = buildThreadAwareOutboundSessionRoute({
      route: baseRoute(),
      replyToId: "reply-1",
      threadId: "thread-1",
      currentSessionKey: "agent:main:workspace:channel:c123:thread:current-1",
    });

    expect(route).toEqual(
      baseRoute({
        sessionKey: "agent:main:workspace:channel:c123:thread:reply-1",
        threadId: "reply-1",
      }),
    );
  });

  it("supports provider-specific threadId-first precedence", () => {
    const route = buildThreadAwareOutboundSessionRoute({
      route: baseRoute(),
      replyToId: "reply-1",
      threadId: "thread-1",
      precedence: ["threadId", "replyToId", "currentSession"],
    });

    expect(route).toEqual(
      baseRoute({
        sessionKey: "agent:main:workspace:channel:c123:thread:thread-1",
        threadId: "thread-1",
      }),
    );
  });

  it("keeps numeric delivery thread ids on the route while stringifying the session suffix", () => {
    const route = buildThreadAwareOutboundSessionRoute({
      route: baseRoute(),
      threadId: 99,
    });

    expect(route).toEqual(
      baseRoute({
        sessionKey: "agent:main:workspace:channel:c123:thread:99",
        threadId: 99,
      }),
    );
  });

  it("recovers a current-session thread only when the base session matches", () => {
    expect(
      recoverCurrentThreadSessionId({
        route: baseRoute(),
        currentSessionKey: "agent:main:workspace:channel:c123:thread:current-1",
      }),
    ).toBe("current-1");
    expect(
      recoverCurrentThreadSessionId({
        route: baseRoute(),
        currentSessionKey: "agent:main:workspace:channel:other:thread:current-1",
      }),
    ).toBeUndefined();
  });

  it("does not recover current-session threads across case-distinct Matrix rooms", () => {
    const route = baseRoute({
      sessionKey: "agent:main:matrix:channel:!Mixed:example.org",
      baseSessionKey: "agent:main:matrix:channel:!Mixed:example.org",
      peer: { kind: "channel", id: "!Mixed:example.org" },
      from: "matrix:room:!Mixed:example.org",
      to: "room:!Mixed:example.org",
    });

    expect(
      recoverCurrentThreadSessionId({
        route,
        currentSessionKey: "agent:main:matrix:channel:!mixed:example.org:thread:$Root",
      }),
    ).toBeUndefined();
  });

  it("keeps recovering current-session threads for non-opaque folded channel keys", () => {
    expect(
      recoverCurrentThreadSessionId({
        route: baseRoute({
          sessionKey: "agent:main:slack:channel:c1",
          baseSessionKey: "agent:main:slack:channel:c1",
        }),
        currentSessionKey: "agent:main:slack:channel:C1:thread:1712345678.123456",
      }),
    ).toBe("1712345678.123456");
  });

  it("lets providers veto current-session recovery", () => {
    const route = buildThreadAwareOutboundSessionRoute({
      route: baseRoute(),
      currentSessionKey: "agent:main:workspace:channel:c123:thread:current-1",
      canRecoverCurrentThread: () => false,
    });

    expect(route).toEqual(
      baseRoute({
        sessionKey: "agent:main:workspace:channel:c123",
      }),
    );
  });

  it("preserves provider-specific thread case when requested", () => {
    const route = buildThreadAwareOutboundSessionRoute({
      route: baseRoute(),
      threadId: "$EventID:Example.Org",
      normalizeThreadId: (threadId) => threadId,
    });

    expect(route).toEqual(
      baseRoute({
        sessionKey: "agent:main:workspace:channel:c123:thread:$EventID:Example.Org",
        threadId: "$EventID:Example.Org",
      }),
    );
  });

  it("can carry a delivery thread without adding a session suffix", () => {
    const route = buildThreadAwareOutboundSessionRoute({
      route: baseRoute(),
      threadId: "thread-1",
      useSuffix: false,
    });

    expect(route).toEqual(
      baseRoute({
        sessionKey: "agent:main:workspace:channel:c123",
        threadId: "thread-1",
      }),
    );
  });
});
