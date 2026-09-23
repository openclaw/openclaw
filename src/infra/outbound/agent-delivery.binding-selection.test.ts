import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentBinding, AgentRouteBinding } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  resolveOutboundChannelPlugin: vi.fn<() => unknown>(),
  resolveChannelTarget: vi.fn<() => Promise<unknown>>(),
  resolveOutboundTarget: vi.fn<() => { ok: true; to: string }>(),
  resolveOutboundSessionRoute: vi.fn<() => Promise<unknown>>(),
  resolveSessionDeliveryTarget: vi.fn(() => ({ channel: "signal", mode: "explicit" })),
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
  isDeliverableMessageChannel: (channel: string) => channel === "signal",
  isGatewayMessageChannel: (channel: string) => channel === "signal",
  normalizeMessageChannel: (value: string) => value.trim().toLowerCase(),
}));

let resolveAgentExplicitRecipientSession: typeof import("./agent-delivery.js").resolveAgentExplicitRecipientSession;
let resolveAgentDeliveryPlanWithSessionRoute: typeof import("./agent-delivery.js").resolveAgentDeliveryPlanWithSessionRoute;

const target = {
  ok: true,
  target: {
    to: "username:recipient",
    kind: "direct",
    source: "normalized",
    resolutionSource: "normalized",
  },
};
const aliasRoute = {
  sessionKey: "agent:ops:main",
  baseSessionKey: "agent:ops:main",
  recipientSessionExact: "direct-alias",
  peer: { kind: "direct", id: "username:recipient" },
  chatType: "direct",
  from: "signal:username:recipient",
  to: "username:recipient",
};
const isolatingBinding: AgentRouteBinding = {
  agentId: "another-agent",
  match: { channel: " SIGNAL ", accountId: "another-account" },
  session: { dmScope: "per-channel-peer" },
};

beforeAll(async () => {
  ({ resolveAgentExplicitRecipientSession, resolveAgentDeliveryPlanWithSessionRoute } =
    await import("./agent-delivery.js"));
});

beforeEach(() => {
  mocks.resolveOutboundChannelPlugin.mockReset();
  mocks.resolveOutboundChannelPlugin.mockReturnValue({
    messaging: { resolveOutboundSessionRoute: vi.fn() },
  });
  mocks.resolveOutboundTarget.mockReset();
  mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "username:recipient" });
  mocks.resolveChannelTarget.mockReset();
  mocks.resolveChannelTarget.mockResolvedValue(target);
  mocks.resolveOutboundSessionRoute.mockReset();
  mocks.resolveOutboundSessionRoute.mockResolvedValue(aliasRoute);
  mocks.resolveSessionDeliveryTarget.mockClear();
});

function resolveRecipient(cfg: OpenClawConfig) {
  return resolveAgentExplicitRecipientSession({
    cfg,
    agentId: "ops",
    channel: "signal",
    to: "username:recipient",
    accountId: "work",
  });
}

function expectAliasResult(
  result: Awaited<ReturnType<typeof resolveRecipient>>,
  isolated: boolean,
) {
  if (isolated) {
    expect(result).toEqual({
      error: expect.objectContaining({
        message: 'Unable to resolve a session route for channel "signal"',
      }),
    });
  } else {
    expect(result).toEqual({
      sessionKey: "agent:ops:main",
      channel: "signal",
      to: "username:recipient",
      accountId: "work",
      threadId: undefined,
      error: undefined,
    });
  }
}

describe("agent delivery binding selection", () => {
  it("reads only the first isolating binding type from 10000 bindings", async () => {
    let typeReads = 0;
    const bindings: AgentRouteBinding[] = Array.from({ length: 10_000 }, () => ({
      agentId: isolatingBinding.agentId,
      match: isolatingBinding.match,
      session: isolatingBinding.session,
      get type() {
        typeReads += 1;
        return "route" as const;
      },
    }));
    const cfg: OpenClawConfig = { bindings };

    const result = await resolveRecipient(cfg);
    const reads = typeReads;

    expectAliasResult(result, true);
    expect(mocks.resolveChannelTarget).toHaveBeenCalledOnce();
    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledOnce();
    expect(cfg.bindings).toBe(bindings);
    expect(bindings).toHaveLength(10_000);
    expect(reads).toBe(1);
  });

  it.each([
    { stage: "target", change: "add" },
    { stage: "target", change: "remove" },
    { stage: "session", change: "add" },
    { stage: "session", change: "remove" },
  ] as const)("observes binding $change during the $stage await", async ({ stage, change }) => {
    const bindings: AgentBinding[] = change === "add" ? [] : [isolatingBinding];
    const cfg: OpenClawConfig = { bindings };
    const entered = createDeferred();
    const resume = createDeferred();
    const resolver =
      stage === "target" ? mocks.resolveChannelTarget : mocks.resolveOutboundSessionRoute;
    resolver.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return stage === "target" ? target : aliasRoute;
    });

    const pending = resolveRecipient(cfg);
    try {
      await entered.promise;
      if (change === "add") {
        bindings.push(isolatingBinding);
      } else {
        bindings.splice(0, 1);
      }
    } finally {
      resume.resolve();
    }
    const result = await pending;

    expectAliasResult(result, change === "add");
    expect(cfg.bindings).toBe(bindings);
    expect(bindings).toEqual(change === "add" ? [isolatingBinding] : []);
    expect(mocks.resolveChannelTarget).toHaveBeenCalledOnce();
    expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledOnce();
  });

  it("ignores ACP, other-channel, and main-scope bindings", async () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          type: "acp",
          agentId: "ops",
          match: { channel: "signal", peer: { kind: "direct", id: "username:recipient" } },
        },
        {
          agentId: "ops",
          match: { channel: "matrix" },
          session: { dmScope: "per-peer" },
        },
        { agentId: "ops", match: { channel: "signal" }, session: { dmScope: "main" } },
        { agentId: "ops", match: { channel: "signal" } },
      ],
    };
    expectAliasResult(await resolveRecipient(cfg), false);
  });

  it.each(["delivery-disabled", "exact-route", "global-isolation"] as const)(
    "does not inspect bindings behind the %s guard",
    async (guard) => {
      let typeReads = 0;
      const cfg: OpenClawConfig = {
        ...(guard === "global-isolation" ? { session: { dmScope: "per-peer" as const } } : {}),
        bindings: [
          {
            ...isolatingBinding,
            get type() {
              typeReads += 1;
              return "route" as const;
            },
          },
        ],
      };
      if (guard === "delivery-disabled") {
        const plan = await resolveAgentDeliveryPlanWithSessionRoute({
          cfg,
          agentId: "ops",
          requestedChannel: "signal",
          explicitTo: "username:recipient",
          wantsDelivery: false,
        });
        expect(plan.resolvedTo).toBe("username:recipient");
        expect(plan.resolvedSessionKey).toBeUndefined();
        expect(mocks.resolveOutboundSessionRoute).not.toHaveBeenCalled();
      } else {
        if (guard === "exact-route") {
          mocks.resolveOutboundSessionRoute.mockResolvedValue({
            ...aliasRoute,
            recipientSessionExact: true,
          });
        }
        expectAliasResult(await resolveRecipient(cfg), guard === "global-isolation");
      }
      expect(typeReads).toBe(0);
    },
  );
});
