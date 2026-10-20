import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mocks, resetResolutionMocks } from "./agent-delivery.resolution.test-support.js";

let resolveAgentDeliveryPlanWithSessionRoute: typeof import("./agent-delivery.js").resolveAgentDeliveryPlanWithSessionRoute;
let resolveAgentOutboundTarget: typeof import("./agent-delivery.js").resolveAgentOutboundTarget;

beforeAll(async () => {
  ({ resolveAgentDeliveryPlanWithSessionRoute, resolveAgentOutboundTarget } =
    await import("./agent-delivery.js"));
});

beforeEach(() => {
  resetResolutionMocks("workspace", true);
  mocks.resolveOutboundSessionRoute.mockResolvedValue(null);
  mocks.resolveSessionDeliveryTarget.mockImplementation(({ requestedChannel, explicitTo }) => ({
    channel: requestedChannel,
    to: explicitTo,
    mode: explicitTo ? "explicit" : "implicit",
  }));
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

function expectDirectoryLookup(input: string, plugin: unknown) {
  expect(mocks.resolveChannelTarget).toHaveBeenCalledWith({
    cfg: {},
    channel: "workspace",
    input,
    accountId: undefined,
    unknownTargetMode: "error",
    plugin,
  });
}

function expectOutboundLookup(to: string | undefined, plugin: unknown) {
  expect(mocks.resolveOutboundTarget).toHaveBeenCalledWith({
    channel: "workspace",
    plugin,
    to,
    cfg: {},
    accountId: undefined,
    mode: "implicit",
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

  it("resolves named targets through the shared directory resolver", async () => {
    const plugin = {
      messaging: {
        resolveOutboundSessionRoute: vi.fn(),
        targetResolver: { resolveTarget: vi.fn() },
      },
    };
    mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "channel:general" });
    resolvedTarget("channel:1524410080953634829");

    const plan = await resolvePlan("channel:general", "agent:main");

    expectDirectoryLookup("channel:general", plugin);
    expect(plan.resolvedTo).toBe("channel:1524410080953634829");
    expect(plan.targetResolutionError).toBeUndefined();
  });

  it("resolves plugin default targets before returning the delivery plan", async () => {
    const plugin = { messaging: { targetResolver: { resolveTarget: vi.fn() } } };
    mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "channel:default-room" });
    resolvedTarget("channel:1524410080953634830");

    const plan = await resolvePlan();

    expectOutboundLookup(undefined, plugin);
    expectDirectoryLookup("channel:default-room", plugin);
    expect(plan.resolvedTo).toBe("channel:1524410080953634830");
    expect(plan.plugin).toBe(plugin);

    mocks.resolveOutboundTarget.mockClear();
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "channel:final" });
    await resolveAgentOutboundTarget({
      cfg: {},
      plan,
      targetMode: "implicit",
      validateExplicitTarget: true,
    });
    expectOutboundLookup("channel:1524410080953634830", plugin);
  });
});
