// Covers agent delivery planning from explicit inputs, session history,
// turn-source overrides, and route-aware target normalization.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveOutboundChannelPlugin: vi.fn<() => unknown>(() => null),
  resolveChannelTarget: vi.fn<() => Promise<unknown>>(async () => ({
    ok: true,
    target: {
      to: "+1999",
      kind: "group",
      source: "normalized",
      resolutionSource: "normalized",
    },
  })),
  resolveOutboundTarget: vi.fn<() => { ok: true; to: string } | { ok: false; error: Error }>(
    () => ({ ok: true, to: "+1999" }),
  ),
  resolveOutboundSessionRoute: vi.fn<() => Promise<unknown>>(async () => null),
  resolveSessionDeliveryTarget: vi.fn(
    (params: {
      entry?: {
        deliveryContext?: {
          channel?: string;
          to?: string;
          accountId?: string;
          threadId?: string | number;
        };
        lastChannel?: string;
        lastTo?: string;
        lastAccountId?: string;
        lastThreadId?: string | number;
      };
      requestedChannel?: string;
      explicitTo?: string;
      explicitThreadId?: string | number;
      turnSourceChannel?: string;
      turnSourceTo?: string;
      turnSourceAccountId?: string;
      turnSourceThreadId?: string | number;
    }) => {
      const sessionContext = params.entry?.deliveryContext ?? {
        channel: params.entry?.lastChannel,
        to: params.entry?.lastTo,
        accountId: params.entry?.lastAccountId,
        threadId: params.entry?.lastThreadId,
      };
      const lastChannel = params.turnSourceChannel ?? sessionContext.channel;
      const lastTo = params.turnSourceChannel ? params.turnSourceTo : sessionContext.to;
      const lastAccountId = params.turnSourceChannel
        ? params.turnSourceAccountId
        : sessionContext.accountId;
      const lastThreadId = params.turnSourceChannel
        ? params.turnSourceThreadId
        : sessionContext.threadId;
      const channel =
        params.requestedChannel === "last" || params.requestedChannel == null
          ? lastChannel
          : params.requestedChannel;
      const mode = params.explicitTo ? "explicit" : "implicit";
      const resolvedTo =
        params.explicitTo ?? (channel && channel === lastChannel ? lastTo : undefined);

      return {
        channel,
        to: resolvedTo,
        accountId: channel && channel === lastChannel ? lastAccountId : undefined,
        threadId:
          params.explicitThreadId ??
          (channel && channel === lastChannel ? lastThreadId : undefined),
        mode,
        lastChannel,
        lastTo,
        lastAccountId,
        lastThreadId,
      };
    },
  ),
}));

vi.mock("./targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
  resolveSessionDeliveryTarget: mocks.resolveSessionDeliveryTarget,
}));

vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

vi.mock("./outbound-session.js", () => ({
  resolveOutboundSessionRoute: mocks.resolveOutboundSessionRoute,
}));

vi.mock("./target-resolver.js", () => ({
  resolveChannelTarget: mocks.resolveChannelTarget,
}));

vi.mock("../../utils/message-channel.js", () => ({
  INTERNAL_MESSAGE_CHANNEL: "webchat",
  isDeliverableMessageChannel: (channel: string) =>
    ["custom", "directchat", "msteams", "telegram", "whatsapp", "workspace"].includes(channel),
  isGatewayMessageChannel: (channel: string) =>
    [
      "custom",
      "directchat",
      "msteams",
      "telegram",
      "webchat",
      "whatsapp",
      "workspace",
    ].includes(channel),
  normalizeMessageChannel: (value: string) => value.trim().toLowerCase(),
}));

import type { OpenClawConfig } from "../../config/config.js";
let resolveAgentDeliveryPlan: typeof import("./agent-delivery.js").resolveAgentDeliveryPlan;
let resolveAgentDeliveryPlanWithSessionRoute: typeof import("./agent-delivery.js").resolveAgentDeliveryPlanWithSessionRoute;
let resolveAgentOutboundTarget: typeof import("./agent-delivery.js").resolveAgentOutboundTarget;

beforeAll(async () => {
  ({
    resolveAgentDeliveryPlan,
    resolveAgentDeliveryPlanWithSessionRoute,
    resolveAgentOutboundTarget,
  } = await import("./agent-delivery.js"));
});

beforeEach(() => {
  mocks.resolveOutboundChannelPlugin.mockReset();
  mocks.resolveOutboundChannelPlugin.mockReturnValue(null);
  mocks.resolveChannelTarget.mockReset();
  mocks.resolveChannelTarget.mockResolvedValue({
    ok: true,
    target: {
      to: "+1999",
      kind: "group",
      source: "normalized",
      resolutionSource: "normalized",
    },
  });
  mocks.resolveOutboundTarget.mockReset();
  mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "+1999" });
  mocks.resolveOutboundSessionRoute.mockReset();
  mocks.resolveOutboundSessionRoute.mockResolvedValue(null);
  mocks.resolveSessionDeliveryTarget.mockClear();
});

function expectDeliveryPlan(params: Parameters<typeof resolveAgentDeliveryPlan>[0]) {
  return resolveAgentDeliveryPlan(params);
}

describe("agent delivery helpers", () => {
  it.each([
    {
      params: {
        sessionEntry: {
          sessionId: "s1",
          updatedAt: 1,
          deliveryContext: { channel: "directchat", to: "+1555", accountId: "work" },
        },
        requestedChannel: "last",
        explicitTo: undefined,
        accountId: undefined,
        wantsDelivery: true,
      },
      expected: {
        resolvedChannel: "directchat",
        resolvedTo: "+1555",
        resolvedAccountId: "work",
        deliveryTargetMode: "implicit",
      },
    },
    {
      params: {
        sessionEntry: undefined,
        requestedChannel: "last",
        explicitTo: undefined,
        accountId: undefined,
        wantsDelivery: true,
      },
      expected: {
        resolvedChannel: "webchat",
        deliveryTargetMode: undefined,
      },
    },
    {
      params: {
        sessionEntry: {
          sessionId: "s4",
          updatedAt: 4,
          deliveryContext: { channel: "workspace", to: "U_WRONG", accountId: "wrong" },
        },
        requestedChannel: "last",
        turnSourceChannel: "directchat",
        turnSourceTo: "+17775550123",
        turnSourceAccountId: "work",
        accountId: undefined,
        wantsDelivery: true,
      },
      expected: {
        resolvedChannel: "directchat",
        resolvedTo: "+17775550123",
        resolvedAccountId: "work",
      },
    },
    {
      params: {
        sessionEntry: {
          sessionId: "s5",
          updatedAt: 5,
          deliveryContext: { channel: "workspace", to: "U_WRONG" },
        },
        requestedChannel: "last",
        turnSourceChannel: "directchat",
        accountId: undefined,
        wantsDelivery: true,
      },
      expected: {
        resolvedChannel: "directchat",
        resolvedTo: undefined,
      },
    },
  ])("builds delivery plan for %j", ({ params, expected }) => {
    const plan = expectDeliveryPlan(params);
    for (const [key, value] of Object.entries(expected)) {
      expect((plan as Record<string, unknown>)[key]).toEqual(value);
    }
  });

  it("resolves fallback targets when no explicit destination is provided", () => {
    const plan = resolveAgentDeliveryPlan({
      sessionEntry: {
        sessionId: "s2",
        updatedAt: 2,
        deliveryContext: { channel: "directchat" },
      },
      requestedChannel: "last",
      explicitTo: undefined,
      accountId: undefined,
      wantsDelivery: true,
    });

    const resolved = resolveAgentOutboundTarget({
      cfg: {} as OpenClawConfig,
      plan,
      targetMode: "implicit",
    });

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledTimes(1);
    expect(resolved.resolvedTarget?.ok).toBe(true);
    expect(resolved.resolvedTo).toBe("+1999");
  });

  it("skips outbound target resolution when explicit target validation is disabled", () => {
    const plan = expectDeliveryPlan({
      sessionEntry: {
        sessionId: "s3",
        updatedAt: 3,
        deliveryContext: { channel: "directchat", to: "+1555" },
      },
      requestedChannel: "last",
      explicitTo: "+1555",
      accountId: undefined,
      wantsDelivery: true,
    });

    mocks.resolveOutboundTarget.mockClear();
    const resolved = resolveAgentOutboundTarget({
      cfg: {} as OpenClawConfig,
      plan,
      targetMode: "explicit",
      validateExplicitTarget: false,
    });

    expect(mocks.resolveOutboundTarget).not.toHaveBeenCalled();
    expect(resolved.resolvedTo).toBe("+1555");
  });

  it("resolves explicit delivery targets through plugin session routing", async () => {
    const pluginRouteResolver = vi.fn();
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: pluginRouteResolver },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: true,
      to: "channel:C123",
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:workspace:channel:C123",
      baseSessionKey: "agent:workspace:channel:C123",
      peer: { kind: "channel", id: "C123" },
      chatType: "channel",
      from: "workspace:channel:C123",
      to: "channel:C123",
      threadId: "1700000000.000100",
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      currentSessionKey: "agent:main",
      sessionEntry: {
        sessionId: "s4",
        updatedAt: 4,
        deliveryContext: { channel: "workspace", to: "channel:C999" },
      },
      requestedChannel: "workspace",
      explicitTo: "workspace:channel:C123:thread:1700000000.000100",
      accountId: "work",
      wantsDelivery: true,
    });

    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith({
      cfg: {},
      channel: "workspace",
      agentId: "agent",
      accountId: "work",
      target: "channel:C123",
      currentSessionKey: "agent:main",
      threadId: undefined,
    });
    expect(plan.resolvedTo).toBe("channel:C123");
    expect(plan.resolvedThreadId).toBe("1700000000.000100");
  });

  it("does not session-route explicit targets before outbound normalization succeeds", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: false,
      error: new Error("ambiguous target"),
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      sessionEntry: undefined,
      requestedChannel: "workspace",
      explicitTo: "1470130713209602050",
      accountId: undefined,
      wantsDelivery: true,
    });

    expect(mocks.resolveOutboundSessionRoute).not.toHaveBeenCalled();
    expect(plan.resolvedTo).toBe("1470130713209602050");
  });

  it("resolves reserved explicit targets through directory-capable resolution before session routing", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn(), targetResolver: {} },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: false,
      error: new Error('Reserved target "current" for Telegram'),
    });
    mocks.resolveChannelTarget.mockResolvedValueOnce({
      ok: true,
      target: {
        to: "telegram:-1002458651455",
        kind: "group",
        source: "directory",
        resolutionSource: "directory",
      },
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:telegram:group:-1002458651455",
      baseSessionKey: "agent:telegram:group:-1002458651455",
      peer: { kind: "group", id: "-1002458651455" },
      chatType: "group",
      from: "telegram:group:-1002458651455",
      to: "telegram:-1002458651455",
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      currentSessionKey: "agent:main",
      sessionEntry: undefined,
      requestedChannel: "telegram",
      explicitTo: "current",
      accountId: "work",
      wantsDelivery: true,
    });

    expect(mocks.resolveChannelTarget).toHaveBeenCalledWith({
      cfg: {},
      channel: "telegram",
      input: "current",
      accountId: "work",
      unknownTargetMode: "normalized",
      plugin: {
        messaging: { resolveOutboundSessionRoute: expect.any(Function), targetResolver: {} },
      },
    });
    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith({
      cfg: {},
      channel: "telegram",
      agentId: "agent",
      accountId: "work",
      target: "telegram:-1002458651455",
      resolvedTarget: {
        to: "telegram:-1002458651455",
        kind: "group",
        source: "directory",
        resolutionSource: "directory",
      },
      currentSessionKey: "agent:main",
      threadId: undefined,
    });
    expect(plan.resolvedTo).toBe("telegram:-1002458651455");
    expect(plan.targetResolutionError).toBeUndefined();
  });

  it("keeps reserved explicit target errors when directory-capable resolution misses", async () => {
    const reservedError = new Error('Reserved target "current" for Telegram');
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn(), targetResolver: {} },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: false,
      error: reservedError,
    });
    mocks.resolveChannelTarget.mockResolvedValueOnce({
      ok: false,
      error: reservedError,
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      sessionEntry: undefined,
      requestedChannel: "telegram",
      explicitTo: "current",
      accountId: undefined,
      wantsDelivery: true,
    });

    expect(mocks.resolveChannelTarget).toHaveBeenCalledWith({
      cfg: {},
      channel: "telegram",
      input: "current",
      accountId: undefined,
      unknownTargetMode: "normalized",
      plugin: {
        messaging: { resolveOutboundSessionRoute: expect.any(Function), targetResolver: {} },
      },
    });
    expect(mocks.resolveOutboundSessionRoute).not.toHaveBeenCalled();
    expect(plan.resolvedTo).toBe("current");
    expect(plan.targetResolutionError).toBe(reservedError);
  });

  it("keeps directory-resolved reserved explicit targets when session-route canonicalization misses", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn(), targetResolver: {} },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: false,
      error: new Error('Reserved target "current" for Telegram'),
    });
    mocks.resolveChannelTarget.mockResolvedValueOnce({
      ok: true,
      target: {
        to: "telegram:-1002458651455",
        kind: "group",
        source: "directory",
        resolutionSource: "directory",
      },
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce(null);

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      currentSessionKey: "agent:main",
      sessionEntry: undefined,
      requestedChannel: "telegram",
      explicitTo: "current",
      accountId: "work",
      wantsDelivery: true,
    });

    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith({
      cfg: {},
      channel: "telegram",
      agentId: "agent",
      accountId: "work",
      target: "telegram:-1002458651455",
      resolvedTarget: {
        to: "telegram:-1002458651455",
        kind: "group",
        source: "directory",
        resolutionSource: "directory",
      },
      currentSessionKey: "agent:main",
      threadId: undefined,
    });
    expect(plan.resolvedTo).toBe("telegram:-1002458651455");
    expect(plan.targetResolutionError).toBeUndefined();
  });

  it("classifies explicit targets when the plugin has no session-route resolver", async () => {
    const resolvedTarget = {
      to: "room:ops",
      kind: "group",
      source: "normalized",
      resolutionSource: "normalized",
    } as const;
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      capabilities: { chatTypes: ["direct", "group"] },
      messaging: {},
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: true,
      to: "room:ops",
    });
    mocks.resolveChannelTarget.mockResolvedValueOnce({
      ok: true,
      target: resolvedTarget,
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce(null);

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      currentSessionKey: "agent:main",
      sessionEntry: undefined,
      requestedChannel: "workspace",
      explicitTo: "room:ops",
      accountId: "work",
      wantsDelivery: true,
    });

    expect(mocks.resolveOutboundSessionRoute).not.toHaveBeenCalled();
    expect(plan.resolvedTo).toBe("room:ops");
    expect(plan.resolvedChatType).toBe("group");
    expect(plan.targetResolutionError).toBeUndefined();
  });

  it("does not rewrite route-less delivery targets while classifying them", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      capabilities: { chatTypes: ["direct", "group"] },
      messaging: {},
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: true,
      to: "user:+1555",
    });
    mocks.resolveChannelTarget.mockResolvedValueOnce({
      ok: true,
      target: {
        to: "user:+1555",
        kind: "user",
        source: "normalized",
        resolutionSource: "normalized",
      },
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      currentSessionKey: "agent:main",
      sessionEntry: undefined,
      requestedChannel: "whatsapp",
      explicitTo: "+1555",
      wantsDelivery: true,
    });

    expect(plan.resolvedTo).toBe("+1555");
    expect(plan.resolvedChatType).toBe("direct");
    expect(plan.targetResolutionError).toBeUndefined();
  });

  it("keeps route-less plugin delivery when target classification is unavailable", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      capabilities: { chatTypes: ["direct"] },
      messaging: {},
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: true,
      to: "conversation:teams-123",
    });
    mocks.resolveChannelTarget.mockResolvedValueOnce({
      ok: false,
      error: new Error("target parser unavailable"),
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      currentSessionKey: "agent:main",
      sessionEntry: {
        sessionId: "s-teams",
        updatedAt: 4,
        lastChannel: "msteams",
        lastTo: "conversation:teams-123",
      },
      requestedChannel: "last",
      wantsDelivery: true,
    });

    expect(plan.resolvedChannel).toBe("msteams");
    expect(plan.resolvedTo).toBe("conversation:teams-123");
    expect(plan.targetResolutionError).toBeUndefined();
  });

  it("keeps route-less explicit-only delivery when target classification rejects", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      capabilities: { chatTypes: ["direct"] },
      messaging: {},
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: true,
      to: "custom-direct-target",
    });
    mocks.resolveChannelTarget.mockRejectedValueOnce(new Error("target lookup failed"));

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      currentSessionKey: "agent:main:custom:direct:alice",
      sessionEntry: {
        sessionId: "s-explicit-only-reject",
        updatedAt: 4,
        chatType: "direct",
        longTermMemoryDefaultPolicy: "explicit-only",
        deliveryContext: { channel: "custom", to: "custom-direct-target" },
      },
      requestedChannel: "last",
      wantsDelivery: true,
    });

    expect(plan.resolvedTo).toBe("custom-direct-target");
    expect(plan.resolvedChatType).toBe("group");
    expect(plan.targetResolutionError).toBeUndefined();
  });

  it("treats route-less explicit-only direct sessions as shared when parsing fails", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      capabilities: { chatTypes: ["direct"] },
      messaging: {},
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: true,
      to: "custom-direct-target",
    });
    mocks.resolveChannelTarget.mockResolvedValueOnce({
      ok: false,
      error: new Error("target parser unavailable"),
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      currentSessionKey: "agent:main:custom:direct:alice",
      sessionEntry: {
        sessionId: "s-explicit-only",
        updatedAt: 4,
        chatType: "direct",
        longTermMemoryDefaultPolicy: "explicit-only",
        deliveryContext: { channel: "custom", to: "custom-direct-target" },
      },
      requestedChannel: "last",
      wantsDelivery: true,
    });

    expect(plan.resolvedTo).toBe("custom-direct-target");
    expect(plan.resolvedChatType).toBe("group");
    expect(plan.targetResolutionError).toBeUndefined();
  });

  it("preserves implicit direct session targets when route-less plugins cannot infer kind", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      capabilities: { chatTypes: ["direct", "group"] },
      messaging: {},
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: true,
      to: "qqbot:c2c:OPENID",
    });
    mocks.resolveChannelTarget.mockResolvedValueOnce({
      ok: true,
      target: {
        to: "qqbot:c2c:OPENID",
        kind: "group",
        source: "normalized",
        resolutionSource: "normalized",
      },
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce(null);

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      currentSessionKey: "agent:main:qqbot:direct:OPENID",
      sessionEntry: {
        sessionId: "s-direct",
        updatedAt: 4,
        chatType: "direct",
        deliveryContext: { channel: "workspace", to: "qqbot:c2c:OPENID" },
      },
      requestedChannel: "last",
      accountId: "work",
      wantsDelivery: true,
    });

    expect(plan.resolvedTo).toBe("qqbot:c2c:OPENID");
    expect(plan.resolvedChatType).toBe("direct");
    expect(plan.targetResolutionError).toBeUndefined();
  });

  it("does not preserve direct fallback hints for explicit-only sessions", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      capabilities: { chatTypes: ["direct", "group"] },
      messaging: {},
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: true,
      to: "qqbot:c2c:OPENID",
    });
    mocks.resolveChannelTarget.mockResolvedValueOnce({
      ok: true,
      target: {
        to: "qqbot:c2c:OPENID",
        kind: "group",
        source: "normalized",
        resolutionSource: "normalized",
      },
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce(null);

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      currentSessionKey: "agent:main:qqbot:direct:OPENID",
      sessionEntry: {
        sessionId: "s-shared-direct-target",
        updatedAt: 4,
        chatType: "direct",
        longTermMemoryDefaultPolicy: "explicit-only",
        deliveryContext: { channel: "workspace", to: "qqbot:c2c:OPENID" },
      },
      requestedChannel: "last",
      accountId: "work",
      wantsDelivery: true,
    });

    expect(plan.resolvedTo).toBe("qqbot:c2c:OPENID");
    expect(plan.resolvedChatType).toBe("group");
    expect(plan.targetResolutionError).toBeUndefined();
  });

  it("surfaces stored explicit target errors even when explicit validation is disabled", () => {
    const targetResolutionError = new Error('reserved target "current"');

    const resolved = resolveAgentOutboundTarget({
      cfg: {} as OpenClawConfig,
      plan: {
        baseDelivery: { mode: "explicit" },
        resolvedChannel: "workspace",
        resolvedTo: "current",
        deliveryTargetMode: "explicit",
        targetResolutionError,
      },
      targetMode: "explicit",
      validateExplicitTarget: false,
    });

    expect(mocks.resolveOutboundTarget).not.toHaveBeenCalled();
    expect(resolved.resolvedTarget).toEqual({ ok: false, error: targetResolutionError });
    expect(resolved.resolvedTo).toBeUndefined();
  });

  it("classifies the target when session-route canonicalization fails", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: true,
      to: "channel:C123",
    });
    mocks.resolveChannelTarget.mockResolvedValueOnce({
      ok: true,
      target: {
        to: "channel:C123",
        kind: "channel",
        source: "normalized",
        resolutionSource: "normalized",
      },
    });
    mocks.resolveOutboundSessionRoute.mockRejectedValueOnce(new Error("route lookup failed"));

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      sessionEntry: undefined,
      requestedChannel: "workspace",
      explicitTo: "channel:C123",
      accountId: undefined,
      wantsDelivery: true,
    });

    expect(mocks.resolveChannelTarget).toHaveBeenCalledWith({
      cfg: {},
      channel: "workspace",
      input: "channel:C123",
      accountId: undefined,
      unknownTargetMode: "normalized",
      plugin: {
        messaging: { resolveOutboundSessionRoute: expect.any(Function) },
      },
    });
    expect(plan.resolvedTo).toBe("channel:C123");
    expect(plan.resolvedChatType).toBe("channel");
    expect(plan.resolvedThreadId).toBeUndefined();
  });

  it("keeps delivery when post-route target classification rejects", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn(), targetResolver: {} },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: true,
      to: "custom-direct-target",
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce(null);
    mocks.resolveChannelTarget.mockRejectedValueOnce(new Error("target lookup failed"));

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      currentSessionKey: "agent:main:custom:direct:alice",
      sessionEntry: {
        sessionId: "s-post-route-explicit-only",
        updatedAt: 4,
        chatType: "direct",
        longTermMemoryDefaultPolicy: "explicit-only",
        deliveryContext: { channel: "custom", to: "custom-direct-target" },
      },
      requestedChannel: "last",
      accountId: undefined,
      wantsDelivery: true,
    });

    expect(plan.resolvedTo).toBe("custom-direct-target");
    expect(plan.resolvedChatType).toBe("group");
    expect(plan.targetResolutionError).toBeUndefined();
  });

  it("does not session-route targets when delivery is disabled", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      sessionEntry: undefined,
      requestedChannel: "workspace",
      explicitTo: "channel:C123",
      accountId: undefined,
      wantsDelivery: false,
    });

    expect(mocks.resolveOutboundTarget).not.toHaveBeenCalled();
    expect(mocks.resolveOutboundSessionRoute).not.toHaveBeenCalled();
    expect(plan.resolvedTo).toBe("channel:C123");
  });

  it("does not pass inherited session threads into explicit retarget routing", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({
      ok: true,
      to: "channel:C123",
    });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:workspace:channel:C123",
      baseSessionKey: "agent:workspace:channel:C123",
      peer: { kind: "channel", id: "C123" },
      chatType: "channel",
      from: "workspace:channel:C123",
      to: "channel:C123",
    });

    const plan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg: {} as OpenClawConfig,
      agentId: "agent",
      sessionEntry: {
        sessionId: "s-thread",
        updatedAt: 5,
        deliveryContext: {
          channel: "workspace",
          to: "channel:C999",
          threadId: "old-thread",
        },
      },
      requestedChannel: "workspace",
      explicitTo: "channel:C123",
      accountId: undefined,
      wantsDelivery: true,
    });

    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "channel:C123",
        threadId: undefined,
      }),
    );
    expect(plan.resolvedThreadId).toBeUndefined();
  });
});
