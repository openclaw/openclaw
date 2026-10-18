import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, normalizedTarget } = vi.hoisted(() => {
  const targetFixture = async (params: { input: string }) => ({
    ok: true,
    target: {
      to: params.input,
      kind: "group",
      source: "normalized",
      resolutionSource: "normalized",
    },
  });
  return {
    normalizedTarget: targetFixture,
    mocks: {
      resolveOutboundChannelPlugin: vi.fn<() => unknown>(() => null),
      resolveChannelTarget: vi.fn<(params: { input: string }) => Promise<unknown>>(targetFixture),
      resolveOutboundTarget: vi.fn<() => { ok: true; to: string } | { ok: false; error: Error }>(
        () => ({ ok: true, to: "+1999" }),
      ),
      resolveOutboundSessionRoute: vi.fn<() => Promise<unknown>>(async () => null),
    },
  };
});

vi.mock("./targets.js", async () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
  resolveSessionDeliveryTarget: (await import("./targets-session.js")).resolveSessionDeliveryTarget,
}));

vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

vi.mock("./outbound-session.js", () => ({
  resolveOutboundSessionRoute: mocks.resolveOutboundSessionRoute,
}));

vi.mock("./target-resolver.js", () => ({ resolveChannelTarget: mocks.resolveChannelTarget }));

vi.mock("../../utils/message-channel.js", () => ({
  INTERNAL_MESSAGE_CHANNEL: "webchat",
  isDeliverableMessageChannel: (channel: string) =>
    [
      "directchat",
      "line",
      "provider",
      "signal",
      "synology-chat",
      "workspace",
      "telegram",
      "whatsapp",
    ].includes(channel),
  isGatewayMessageChannel: (channel: string) =>
    ["directchat", "workspace", "telegram", "whatsapp", "webchat"].includes(channel),
  normalizeMessageChannel: (value: string) => value.trim().toLowerCase(),
}));

import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { normalizeLegacySessionEntryDelivery } from "../state-migrations.legacy-session-store.js";
let resolveAgentDeliveryPlanWithSessionRoute: typeof import("./agent-delivery.js").resolveAgentDeliveryPlanWithSessionRoute;
let resolveAgentExplicitRecipientSession: typeof import("./agent-delivery.js").resolveAgentExplicitRecipientSession;
let resolveAgentOutboundTarget: typeof import("./agent-delivery.js").resolveAgentOutboundTarget;

beforeAll(async () => {
  ({
    resolveAgentDeliveryPlanWithSessionRoute,
    resolveAgentExplicitRecipientSession,
    resolveAgentOutboundTarget,
  } = await import("./agent-delivery.js"));
});

beforeEach(() => {
  mocks.resolveOutboundChannelPlugin.mockReset().mockReturnValue(null);
  mocks.resolveChannelTarget.mockReset().mockImplementation(normalizedTarget);
  mocks.resolveOutboundTarget.mockReset().mockReturnValue({ ok: true, to: "+1999" });
  mocks.resolveOutboundSessionRoute.mockReset().mockResolvedValue(null);
});

async function buildDeliveryPlan(
  params: Omit<
    Parameters<typeof resolveAgentDeliveryPlanWithSessionRoute>[0],
    "cfg" | "agentId" | "sessionEntry" | "wantsDelivery"
  > & { sessionEntry?: SessionEntry & { deliveryContext?: DeliveryContext } },
) {
  return await resolveAgentDeliveryPlanWithSessionRoute({
    cfg: {} as OpenClawConfig,
    agentId: "agent",
    wantsDelivery: true,
    ...params,
    sessionEntry: params.sessionEntry
      ? normalizeLegacySessionEntryDelivery(params.sessionEntry)
      : undefined,
  });
}

function recipient(
  params: Omit<Parameters<typeof resolveAgentExplicitRecipientSession>[0], "cfg" | "agentId"> &
    Partial<Pick<Parameters<typeof resolveAgentExplicitRecipientSession>[0], "cfg" | "agentId">>,
) {
  return resolveAgentExplicitRecipientSession({ cfg: {}, agentId: "ops", ...params });
}

function rejectedRoute(
  key: string,
  id: string,
  from: string,
  exact: boolean | "direct-alias" | "delivery-identity",
) {
  return {
    sessionKey: key,
    baseSessionKey: key,
    recipientSessionExact: exact,
    peer: { kind: "direct", id },
    chatType: "direct",
    from,
    to: id,
  };
}

describe("agent delivery helpers", () => {
  it.each([
    {
      params: { requestedChannel: "last" },
      expected: { resolvedChannel: "webchat", deliveryTargetMode: undefined },
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
      },
      expected: {
        resolvedChannel: "directchat",
        resolvedTo: "+17775550123",
        resolvedAccountId: "work",
      },
    },
  ])("builds delivery plan for %j", async ({ params, expected }) => {
    const plan = await buildDeliveryPlan(params);
    expect(plan).toMatchObject(expected);
  });

  it("resolves fallback targets when no explicit destination is provided", async () => {
    const plan = await buildDeliveryPlan({
      sessionEntry: {
        sessionId: "s2",
        updatedAt: 2,
        deliveryContext: { channel: "directchat" },
      },
      requestedChannel: "last",
    });

    const resolved = await resolveAgentOutboundTarget({
      cfg: {} as OpenClawConfig,
      plan,
      targetMode: "implicit",
    });

    expect(mocks.resolveOutboundTarget).toHaveBeenCalledTimes(1);
    expect(resolved).toMatchObject({ resolvedTarget: { ok: true }, resolvedTo: "+1999" });
  });

  it("skips outbound target resolution when explicit target validation is disabled", async () => {
    const plan = await buildDeliveryPlan({
      sessionEntry: {
        sessionId: "s3",
        updatedAt: 3,
        deliveryContext: { channel: "directchat", to: "+1555" },
      },
      requestedChannel: "last",
      explicitTo: "+1555",
    });

    mocks.resolveOutboundTarget.mockClear();
    const resolved = await resolveAgentOutboundTarget({
      cfg: {} as OpenClawConfig,
      plan,
      targetMode: "explicit",
      validateExplicitTarget: false,
    });

    expect(mocks.resolveOutboundTarget).not.toHaveBeenCalled();
    expect(resolved.resolvedTo).toBe("+1555");
  });

  it("resolves recipient sessions through native target routing with account identity", async () => {
    const plugin = {
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    };
    mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);
    mocks.resolveOutboundTarget.mockReturnValueOnce({ ok: true, to: "120363040000000000@g.us" });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:ops:whatsapp:group:120363040000000000@g.us",
      baseSessionKey: "agent:ops:whatsapp:group:120363040000000000@g.us",
      recipientSessionExact: true,
      peer: { kind: "group", id: "120363040000000000@g.us" },
      chatType: "group",
      from: "120363040000000000@g.us",
      to: "120363040000000000@g.us",
      threadId: "topic-42",
    });

    const result = await recipient({
      channel: "whatsapp",
      to: "120363040000000000@g.us",
      accountId: "work",
      threadId: "topic-42",
    });

    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith({
      cfg: {},
      channel: "whatsapp",
      plugin,
      agentId: "ops",
      accountId: "work",
      target: "120363040000000000@g.us",
      threadId: "topic-42",
    });
    expect(result).toEqual({
      sessionKey: "agent:ops:whatsapp:group:120363040000000000@g.us",
      channel: "whatsapp",
      to: "120363040000000000@g.us",
      accountId: "work",
      threadId: "topic-42",
      error: undefined,
    });
  });

  it.each([
    {
      name: "rejects best-effort plugin routes for explicit recipient sessions",
      input: { agentId: "main", channel: "provider", to: "@ambiguous" },
      route: rejectedRoute("agent:main:main", "@ambiguous", "provider:@ambiguous", false),
    },
    {
      name: "rejects main aliases when a channel binding isolates direct peers",
      input: {
        channel: "signal",
        to: "username:alice.01",
        cfg: {
          session: { dmScope: "main" },
          bindings: [
            {
              agentId: "ops",
              match: { channel: "signal", peer: { kind: "direct", id: "+15551234567" } },
              session: { dmScope: "per-channel-peer" },
            },
          ],
        } satisfies OpenClawConfig,
      },
      route: rejectedRoute(
        "agent:ops:main",
        "username:alice.01",
        "signal:username:alice.01",
        "direct-alias",
      ),
    },
    {
      name: "rejects aliases outside the configured main session key",
      input: { channel: "signal", to: "username:alice.01", cfg: { session: { mainKey: "work" } } },
      route: rejectedRoute(
        "agent:ops:main",
        "username:alice.01",
        "signal:username:alice.01",
        "direct-alias",
      ),
    },
    {
      name: "rejects outbound-only identities outside the real provider namespace",
      input: { channel: "synology-chat", to: "42" },
      normalizedTo: "42",
      route: rejectedRoute(
        "agent:ops:synthetic:direct:42",
        "42",
        "synthetic:42",
        "delivery-identity",
      ),
    },
    {
      name: "rejects explicit recipients when no usable route can be inferred",
      input: { channel: "provider", to: "missing" },
      normalizedTo: "missing",
      route: null,
    },
  ])("$name", async ({ input, route, normalizedTo }) => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      config: { listAccountIds: () => [] },
      ...(route ? { messaging: { resolveOutboundSessionRoute: vi.fn() } } : {}),
    });
    if (normalizedTo) {
      mocks.resolveOutboundTarget.mockReturnValueOnce({ ok: true, to: normalizedTo });
    }
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce(route);
    const result = await recipient(input);
    expect(result.sessionKey).toBeUndefined();
    expect(result.error?.message).toBe(
      `Unable to resolve a session route for channel "${input.channel}"`,
    );
  });

  it("accepts stable outbound-only identities that stay isolated from main", async () => {
    const plugin = {
      capabilities: { chatTypes: ["direct"] },
      config: { listAccountIds: () => [] },
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    };
    mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);
    mocks.resolveOutboundTarget.mockReturnValueOnce({ ok: true, to: "42" });
    mocks.resolveOutboundSessionRoute.mockResolvedValueOnce({
      sessionKey: "agent:ops:synology-chat:default:direct:chat-api-42",
      baseSessionKey: "agent:ops:synology-chat:default:direct:chat-api-42",
      recipientSessionExact: "delivery-identity",
      peer: { kind: "direct", id: "chat-api-42" },
      chatType: "direct",
      from: "synology-chat:chat-api:42",
      to: "42",
    });

    const result = await recipient({ channel: "synology-chat", to: "42" });

    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith({
      cfg: {},
      channel: "synology-chat",
      plugin,
      agentId: "ops",
      accountId: "default",
      target: "42",
      currentSessionKey: undefined,
      threadId: undefined,
    });
    expect(result).toMatchObject({
      sessionKey: "agent:ops:synology-chat:default:direct:chat-api-42",
      channel: "synology-chat",
      to: "42",
      accountId: "default",
      error: undefined,
    });
  });

  it("keeps reserved explicit target errors when directory-capable resolution misses", async () => {
    const reservedError = new Error('Reserved target "current" for Telegram');
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn(), targetResolver: {} },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({ ok: false, error: reservedError });
    mocks.resolveChannelTarget.mockResolvedValueOnce({ ok: false, error: reservedError });

    const plan = await buildDeliveryPlan({ requestedChannel: "telegram", explicitTo: "current" });

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

    const plan = await buildDeliveryPlan({
      currentSessionKey: "agent:main",
      requestedChannel: "telegram",
      explicitTo: "current",
      accountId: "work",
    });

    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledWith({
      cfg: {},
      channel: "telegram",
      plugin: {
        messaging: { resolveOutboundSessionRoute: expect.any(Function), targetResolver: {} },
      },
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
    expect(plan).toMatchObject({
      resolvedTo: "telegram:-1002458651455",
      targetResolutionError: undefined,
    });
  });

  it("surfaces stored explicit target errors even when explicit validation is disabled", async () => {
    const targetResolutionError = new Error('reserved target "current"');

    const resolved = await resolveAgentOutboundTarget({
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

  it("falls back to the original plan when session-route canonicalization fails", async () => {
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });
    mocks.resolveOutboundTarget.mockReturnValueOnce({ ok: true, to: "channel:C123" });
    mocks.resolveOutboundSessionRoute.mockRejectedValueOnce(new Error("route lookup failed"));

    const plan = await buildDeliveryPlan({
      requestedChannel: "workspace",
      explicitTo: "channel:C123",
    });

    expect(plan).toMatchObject({ resolvedTo: "channel:C123", resolvedThreadId: undefined });
  });
});
