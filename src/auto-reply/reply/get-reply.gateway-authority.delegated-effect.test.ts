import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { bindAgentToolGatewayRequest } from "../../agents/tools/in-process-gateway.js";
import { buildChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../../channels/inbound-event/host-context-builder.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import { createHostChannelIngressRuntime } from "../../channels/message-access/runtime.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import { prepareDelegatedSystemAgentApproval } from "../../gateway/server-methods/system-agent-approval.js";
import type { SystemAgentChatSession } from "../../gateway/server-methods/system-agent.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "../../gateway/server-methods/types.js";
import {
  claimAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
} from "../../infra/agent-run-registry.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { initFastReplySessionState, withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { finalizeInboundContext } from "./inbound-context.js";

// Retained channel authority must expire before a delegated operation performs
// its final effect. The Gateway host stays live in every case here, so only the
// channel's own lifetime can reject the already-prepared call.

const METHOD = "sessions.list";
const SCOPE = "operator.read";

type ChannelLifecycle = "live" | "unbound" | "retired" | "replaced";

let state: OpenClawTestState | undefined;
afterEach(async () => {
  await state?.cleanup();
  state = undefined;
  resetAgentRunRegistryForTest();
});

function createLiveGateway(
  handler?: (options: GatewayRequestHandlerOptions) => unknown,
): GatewayRequestContext {
  const context = {
    trackExecution: trackAsyncWork,
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    logGateway: { error: () => {}, warn: () => {} },
  } as unknown as GatewayRequestContext;
  if (handler) {
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        {
          name: METHOD,
          scope: SCOPE,
          owner: { kind: "core", area: "sessions" },
          handler: handler as never,
        },
      ]);
  }
  return context;
}

async function createTestState(label: string) {
  state = await createOpenClawTestState({ label, env: { OPENCLAW_TEST_FAST: "0" } });
  const cfg = withFullRuntimeReplyConfig({
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "mock-openai/gpt-5.6-luna" },
        models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
      },
    },
    plugins: { enabled: false },
    session: { dmScope: "per-channel-peer" },
  });
  await state.writeConfig(cfg);
  return { cfg, workspaceDir: state.workspaceDir };
}

/**
 * Drives real channel ingress through real reply preparation and hands back the
 * copied, lifetime-fenced resolver exactly as agent-runner-execution.ts reads it,
 * plus the revocation the scenario under test applies afterwards.
 */
async function prepareChannelBoundResolver(params: {
  cfg: ReturnType<typeof withFullRuntimeReplyConfig>;
  workspaceDir: string;
  lifecycle: ChannelLifecycle;
  gatewayContext: GatewayRequestContext;
  successorGateway: GatewayRequestContext;
}) {
  let successorResolutions = 0;
  const owner = {
    channelId: "discord",
    isLive: () => live,
    // The Gateway never goes away; only the channel lifetime is revoked.
    resolveGatewayContext: () => params.gatewayContext,
  };
  let live = true;
  const revoke = () => {
    live = false;
    if (params.lifecycle === "replaced") {
      createHostChannelIngressRuntime({
        channelId: "discord",
        isLive: () => true,
        resolveGatewayContext: () => {
          successorResolutions += 1;
          return params.successorGateway;
        },
      });
    }
  };

  const sessionKey = "agent:main:discord:direct:person-42";
  const ingress = await createHostChannelIngressRuntime(owner).resolveStable({
    channelId: "discord",
    accountId: "primary",
    subject: { stableId: "person-42" },
    conversation: { kind: "direct", id: "dm-1" },
    contextBinding: {
      agentId: "main",
      sessionKey,
      messageId: "msg-1",
      inboundEventKind: "user_request",
    },
    dmPolicy: "allowlist",
    groupPolicy: "disabled",
    allowFrom: ["person-42"],
  });
  const context = await createHostChannelInboundEventContextBuilder(
    buildChannelInboundEventContext,
    owner,
  )({
    channel: "discord",
    accountId: "primary",
    messageId: "msg-1",
    from: "discord:user:person-42",
    sender: { id: "person-42" },
    conversation: { kind: "direct", id: "dm-1", nativeChannelId: "dm-1" },
    route: { agentId: "main", routeSessionKey: sessionKey },
    reply: { to: "channel:dm-1" },
    message: { rawBody: "hello" },
    channelIngress: ingress,
  });
  const input = finalizeInboundContext(params.lifecycle === "unbound" ? { ...context } : context);
  const fast = initFastReplySessionState({
    ctx: input,
    cfg: params.cfg,
    agentId: "main",
    commandAuthorized: true,
    workspaceDir: params.workspaceDir,
  });
  return {
    resolver: readChannelContextGatewayContextResolver(fast.sessionCtx),
    revoke,
    sessionKey,
    readSuccessorResolutions: () => successorResolutions,
  };
}

it.each([
  { lifecycle: "live" as const, midFlight: false, effect: true },
  { lifecycle: "unbound" as const, midFlight: false, effect: false },
  { lifecycle: "retired" as const, midFlight: false, effect: false },
  { lifecycle: "replaced" as const, midFlight: false, effect: false },
  { lifecycle: "retired" as const, midFlight: true, effect: false },
  { lifecycle: "replaced" as const, midFlight: true, effect: false },
])(
  "rejects a prepared delegated Gateway call before its effect when $lifecycle (mid-flight: $midFlight)",
  async ({ lifecycle, midFlight, effect }) => {
    const { cfg, workspaceDir } = await createTestState("channel-gateway-delegated-effect");
    const effectPath = path.join(workspaceDir, "delegated-effect.txt");
    let handlerEntered = 0;
    let revokeMidFlight: (() => void) | undefined;
    const gatewayContext = createLiveGateway(async (options) => {
      handlerEntered += 1;
      if (midFlight) {
        await Promise.resolve();
        revokeMidFlight?.();
        await Promise.resolve();
      }
      // Production pre-commit fence every session-mutating handler runs.
      options.sessionMutationCommitGuard?.();
      fs.writeFileSync(effectPath, "delegated effect performed");
      options.respond(true, { sessions: [] });
    });
    const successorGateway = createLiveGateway(() => {
      throw new Error("successor Gateway must not be redeemed by a retired channel binding");
    });

    const bound = await prepareChannelBoundResolver({
      cfg,
      workspaceDir,
      lifecycle,
      gatewayContext,
      successorGateway,
    });
    expect(bound.resolver !== undefined).toBe(lifecycle !== "unbound");

    const outcome = await withPluginRuntimeGatewayContextResolver(bound.resolver, async () => {
      const call = bindAgentToolGatewayRequest();
      if (midFlight) {
        revokeMidFlight = bound.revoke;
      } else if (lifecycle !== "live") {
        bound.revoke();
      }
      // The binding is already captured; asynchronous reply preparation follows.
      await Promise.resolve();
      try {
        await call({ method: METHOD, params: {}, scopes: [SCOPE] });
        return "accepted";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });

    expect(fs.existsSync(effectPath)).toBe(effect);
    expect(outcome === "accepted").toBe(effect);
    expect(bound.readSuccessorResolutions()).toBe(0);
    if (!effect) {
      // The handler may have started, but it must never reach its final effect.
      expect(handlerEntered).toBe(midFlight ? 1 : 0);
    }

    // The Gateway host itself is untouched: a call bound straight to a live root
    // Gateway still reaches final I/O.
    const controlPath = path.join(workspaceDir, "control-effect.txt");
    const controlGateway = createLiveGateway((options) => {
      options.sessionMutationCommitGuard?.();
      fs.writeFileSync(controlPath, "control effect performed");
      options.respond(true, { sessions: [] });
    });
    await withPluginRuntimeGatewayContextResolver(
      () => controlGateway,
      async () =>
        await bindAgentToolGatewayRequest()({ method: METHOD, params: {}, scopes: [SCOPE] }),
    );
    expect(fs.existsSync(controlPath)).toBe(true);
  },
);

it.each([
  { lifecycle: "live" as const, applied: true },
  { lifecycle: "retired" as const, applied: false },
  { lifecycle: "replaced" as const, applied: false },
])(
  "fences the delegated system-agent apply owner when the channel is $lifecycle",
  async ({ lifecycle, applied }) => {
    const { cfg, workspaceDir } = await createTestState("channel-gateway-delegated-approval");
    const gatewayContext = createLiveGateway();
    const successorGateway = createLiveGateway();
    const bound = await prepareChannelBoundResolver({
      cfg,
      workspaceDir,
      lifecycle,
      gatewayContext,
      successorGateway,
    });
    if (!bound.resolver) {
      throw new Error("expected the channel binding to reach the reply session context");
    }

    const started = createDeferred();
    const release = createDeferred();
    const applyEffect = vi.fn();
    const proposal = { operation: { kind: "gateway-restart" as const }, hash: "d".repeat(64) };
    const session = {
      engine: {
        resolveOperatorApproval: async (
          decision: ExecApprovalDecision | null,
          _hash: string,
          assertCurrent?: () => void,
        ) => {
          if (decision === null) {
            return null;
          }
          started.resolve();
          await release.promise;
          // Production fence the real apply owner runs before its effect.
          assertCurrent?.();
          applyEffect();
          return { text: "Applied", action: "none" as const, applied: true };
        },
      },
      ownerKey: bound.sessionKey,
      lastUsedAt: 1,
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegate-channel", session]]);
    const approvalContext = {
      systemAgentSessions: sessions,
      validateAgentRuntimeApprovalAuthority: () => true,
    } as unknown as GatewayRequestContext;
    const operationalRunInstance = createOperationalRunInstanceRef("channel-delegated-run");
    const approvalAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);

    const pending = withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: bound.sessionKey,
        operationalRunInstance,
        approvalAuthority,
        fullPermission: true,
        // The exact resolver this PR copies into the reply session context.
        gatewayContextResolver: bound.resolver,
      },
      async () => {
        const resolveProposal = await prepareDelegatedSystemAgentApproval({
          context: approvalContext,
          sessions,
          session,
          sessionId: "delegate-channel",
          delegation: { agentId: "main", sessionKey: bound.sessionKey },
        });
        return await resolveProposal(proposal as never);
      },
    );

    await started.promise;
    if (!applied) {
      // Revocation lands while the apply owner is awaiting its queued work.
      bound.revoke();
    }
    release.resolve();

    if (applied) {
      await expect(pending).resolves.toMatchObject({ kind: "completed" });
      expect(applyEffect).toHaveBeenCalledTimes(1);
    } else {
      await expect(pending).rejects.toThrow("system-agent approval authority is no longer active");
      expect(applyEffect).not.toHaveBeenCalled();
    }
    expect(bound.readSuccessorResolutions()).toBe(0);
    // The Gateway host stayed live throughout; only the channel authority expired.
    expect(gatewayContext).toBeDefined();
  },
);
