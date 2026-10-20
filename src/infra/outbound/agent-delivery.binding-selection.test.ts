import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentBinding, AgentRouteBinding } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { mocks, resetResolutionMocks } from "./agent-delivery.resolution.test-support.js";

let resolveAgentExplicitRecipientSession: typeof import("./agent-delivery.js").resolveAgentExplicitRecipientSession;
const recipient = { channel: "signal", to: "username:recipient", accountId: "work" };

const target = {
  ok: true,
  target: {
    to: "username:recipient",
    resolutionSource: "normalized",
  },
};
const aliasRoute = {
  sessionKey: "agent:ops:main",
  baseSessionKey: "agent:ops:main",
  recipientSessionExact: "direct-alias",
  chatType: "direct",
  to: "username:recipient",
};
const isolatingBinding: AgentRouteBinding = {
  agentId: "another-agent",
  match: { channel: " SIGNAL ", accountId: "another-account" },
  session: { dmScope: "per-channel-peer" },
};

beforeAll(async () => {
  ({ resolveAgentExplicitRecipientSession } = await import("./agent-delivery.js"));
});

beforeEach(() => {
  resetResolutionMocks("signal");
  mocks.resolveOutboundChannelPlugin.mockReturnValue({
    messaging: { resolveOutboundSessionRoute: vi.fn() },
  });
  mocks.resolveOutboundTarget.mockReturnValue({ ok: true, to: "username:recipient" });
  mocks.resolveChannelTarget.mockResolvedValue(target);
  mocks.resolveOutboundSessionRoute.mockResolvedValue(aliasRoute);
  mocks.resolveSessionDeliveryTarget.mockReturnValue({ channel: "signal", mode: "explicit" });
});

function resolveRecipient(cfg: OpenClawConfig) {
  return resolveAgentExplicitRecipientSession({ cfg, agentId: "ops", ...recipient });
}

function expectAliasResult(
  result: Awaited<ReturnType<typeof resolveRecipient>>,
  isolated: boolean,
) {
  expect(result).toEqual(
    isolated
      ? {
          error: expect.objectContaining({
            message: 'Unable to resolve a session route for channel "signal"',
          }),
        }
      : {
          sessionKey: "agent:ops:main",
          ...recipient,
          threadId: undefined,
          error: undefined,
        },
  );
}

it.each([
  ["binding-isolation", 10_000, 1],
  ["global-isolation", 1, 0],
] as const)("honors %s with bounded binding inspection", async (mode, count, reads) => {
  let typeReads = 0;
  const bindings: AgentBinding[] = Array.from({ length: count }, () => ({
    ...isolatingBinding,
    get type() {
      typeReads += 1;
      return "route" as const;
    },
  }));
  const cfg: OpenClawConfig = {
    bindings,
    ...(mode === "global-isolation" ? { session: { dmScope: "per-peer" as const } } : {}),
  };
  expectAliasResult(await resolveRecipient(cfg), true);
  expect(mocks.resolveChannelTarget).toHaveBeenCalledOnce();
  expect(mocks.resolveOutboundSessionRoute).toHaveBeenCalledOnce();
  expect(typeReads).toBe(reads);
  expect(cfg.bindings).toBe(bindings);
  expect(bindings).toHaveLength(count);
});

it.each([
  { stage: "target", change: "remove" },
  { stage: "session", change: "add" },
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
