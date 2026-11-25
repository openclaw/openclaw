import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveOutboundChannelPlugin: vi.fn<() => unknown>(),
  resolveChannelTarget: vi.fn<(params: { input: string }) => Promise<unknown>>(),
  resolveOutboundTarget: vi.fn<() => { ok: true; to: string } | { ok: false; error: Error }>(),
  resolveOutboundSessionRoute: vi.fn<() => Promise<unknown>>(),
  resolveSessionDeliveryTarget: vi.fn(
    (params: { requestedChannel?: string; explicitTo?: string }) => ({
      channel: params.requestedChannel,
      to: params.explicitTo,
      mode: params.explicitTo ? "explicit" : "implicit",
    }),
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
  isDeliverableMessageChannel: (channel: string) => channel === "workspace",
  isGatewayMessageChannel: (channel: string) => ["webchat", "workspace"].includes(channel),
  normalizeMessageChannel: (value: string) => value.trim().toLowerCase(),
}));

let resolveAgentDeliveryPlanWithSessionRoute: typeof import("./agent-delivery.js").resolveAgentDeliveryPlanWithSessionRoute;

beforeAll(async () => {
  ({ resolveAgentDeliveryPlanWithSessionRoute } = await import("./agent-delivery.js"));
});

beforeEach(() => {
  mocks.resolveOutboundChannelPlugin.mockReset();
  mocks.resolveChannelTarget.mockReset();
  mocks.resolveOutboundTarget.mockReset();
  mocks.resolveOutboundSessionRoute.mockReset();
  mocks.resolveOutboundSessionRoute.mockResolvedValue(null);
  mocks.resolveSessionDeliveryTarget.mockClear();
});

function resolvePlan(explicitTo?: string, currentSessionKey?: string) {
  return resolveAgentDeliveryPlanWithSessionRoute({
    cfg: {},
    agentId: "agent",
    currentSessionKey,
    requestedChannel: "workspace",
    explicitTo,
    wantsDelivery: true,
  });
}

function resolvedTarget(to: string, kind = "channel", source = "directory") {
  mocks.resolveChannelTarget.mockResolvedValue({
    ok: true,
    target: { to, kind, source, resolutionSource: source },
  });
}

describe("agent delivery target resolution", () => {
  it("does not session-route targets when outbound validation fails", async () => {
    const targetError = new Error("ambiguous target");
    mocks.resolveOutboundChannelPlugin.mockReturnValue({
      messaging: { resolveOutboundSessionRoute: vi.fn() },
    });
    mocks.resolveOutboundTarget.mockReturnValue({ ok: false, error: targetError });
    resolvedTarget("1470130713209602050", "group", "normalized");

    const plan = await resolvePlan("1470130713209602050");

    expect(mocks.resolveOutboundSessionRoute).not.toHaveBeenCalled();
    expect(plan.resolvedTo).toBe("1470130713209602050");
    expect(plan.targetResolutionError).toBe(targetError);
  });
});
