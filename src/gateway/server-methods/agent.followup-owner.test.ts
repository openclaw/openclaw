// Keep shared fixture mock registration before the production imports.
// oxfmt-ignore
import {
  describe1AfterEach1,
  describe1BeforeEach0,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  prime,
} from "./agent.test-harness.js";
// Provider/session fixtures are isolated; RPC admission, authority, and plugin effects are real.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { prepareAgentCommandExecutionIdentity } from "../../agents/agent-command-execution-identity.js";
import type { AgentCommandGatewayIngressOpts } from "../../agents/command/types.js";
import {
  bindRequesterOwnerIdentity,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { SessionFollowupCompletion } from "../../agents/subagents/completion/session-followup-completion.js";
import {
  captureRequesterFollowupAuthority,
  revokeRequesterCronAuthority,
} from "../../agents/subagents/requester-cron-authority.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  captureGatewayToolCallerAssertion,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import type { AgentToolGatewayRequestCaller } from "../../agents/tools/in-process-gateway.js";
import { startSessionsSendReplyFlow } from "../../agents/tools/sessions-send-reply-flow.js";
import { isConfiguredCommandOwner } from "../../auto-reply/command-auth.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { setGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import {
  retainGatewayPluginMetadata,
  type GatewayPluginMetadataOwner,
} from "../../plugins/plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createPluginToolFactoryContext } from "../../plugins/tool-factory-context.js";
import { bindPluginToolCallbacks } from "../../plugins/tool-factory-runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { agentHandlers } from "./agent.js";
import type { RespondFn } from "./types.js";

let metadataOwner: GatewayPluginMetadataOwner | undefined;
beforeAll(() => {
  metadataOwner = retainGatewayPluginMetadata(createTestGatewayScheduler());
  const snapshot = metadataOwner.runBootstrap(() =>
    loadPluginMetadataSnapshot({ config: {}, allowCurrent: false }),
  );
  metadataOwner.publish(snapshot);
  setGatewayPluginMetadataSnapshot(snapshot, { config: {} });
});
afterAll(async () => {
  await metadataOwner?.close();
});

const SESSION = "agent:main:main";
const SESSION_ID = "existing-session-id";
const CHILD = "agent:main:subagent:owner-proof";
const mocks = getAgentTestMocks();

describe("Gateway followup owner final effect", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  beforeEach(async () => {
    await describe1BeforeEach0();
    const registry = await vi.importActual<typeof import("../../infra/agent-run-registry.js")>(
      "../../infra/agent-run-registry.js",
    );
    mocks.lifecycleGeneration = registry.getAgentRunLifecycleGeneration();
    vi.mocked(getAgentRunContext).mockImplementation(registry.getAgentRunContext);
    mocks.clearAgentRunContext.mockImplementation(registry.clearAgentRunContext);
    // The shared handler fixture aliases register and claim. Delegate each real signature.
    mocks.registerAgentRunContext.mockImplementation((runId, context, options) =>
      typeof options === "object"
        ? registry.claimAgentRunContext(runId, context, options)
        : registry.registerAgentRunContext(runId, context, options),
    );
  });
  afterEach(async () => {
    revokeRequesterCronAuthority(SESSION);
    await describe1AfterEach1();
  });

  it.each(["observer error", "observer error before dispatch", "cancel before dispatch"] as const)(
    "checks %s after RPC admission and before a versioned plugin writes",
    async (outcome) => {
      const root = dirs.make("openclaw-followup-owner-effect-");
      const output = path.join(root, "owner-effect.txt");
      const config = { commands: { ownerAllowFrom: ["discord:owner-1"] } };
      prime(SESSION_ID, config);
      mocks.loadConfigReturn = config;
      const isOwner = () =>
        isConfiguredCommandOwner(mocks.loadConfigReturn, {
          channel: "discord",
          senderId: "owner-1",
        });
      const originalRunId = "original-owner-proof";
      const { operationalRunInstance } = createTestAdmittedRunContext(originalRunId);
      const delegated = claimAgentRunDelegatedAuthority(operationalRunInstance);
      registerAgentRunContext(originalRunId, {
        agentId: "main",
        sessionKey: SESSION,
        sessionId: SESSION_ID,
      });
      let authorityReleased = false;
      const authorityRetired = createDeferredCore();
      let requesterAuthority: ReturnType<typeof captureRequesterFollowupAuthority>;
      try {
        const original = createCronCreatorAuthorityCapability(
          originalRunId,
          { kind: "unknown" },
          { source: "channel-owner", isCurrent: isOwner },
          () => true,
          undefined,
          { senderId: "owner-1", channel: "discord", isCurrent: isOwner },
        )!;
        await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: SESSION,
            operationalRunInstance,
            approvalAuthority: delegated,
          },
          () =>
            runWithCronCreatorAuthorityCapability(original, async () => {
              requesterAuthority = captureRequesterFollowupAuthority({
                requesterTurnRunId: originalRunId,
                requesterAgentId: "main",
                requesterSessionKey: SESSION,
                requesterSessionId: SESSION_ID,
                sourceSessionKey: CHILD,
                isCurrent: () => !authorityReleased,
                release: () => {
                  authorityReleased = true;
                  authorityRetired.resolve();
                },
              });
            }),
        );
      } finally {
        releaseAgentRunDelegatedAuthority(delegated);
        clearAgentRunContext(originalRunId);
      }
      expect(requesterAuthority).toBeDefined();
      const closed = createDeferredCore();
      const parentSettled = createDeferredCore();
      const entered = createDeferredCore();
      const releaseEffect = createDeferredCore();
      let pluginError: unknown;
      let gatewayError: unknown;
      let effectStarted = false;
      const completion = SessionFollowupCompletion.bind({
        runId: "owner-proof-child",
        requesterSessionKey: SESSION,
        requesterSessionId: SESSION_ID,
        requesterAgentId: "main",
        targetSessionKey: CHILD,
        targetAgentId: "main",
        requesterAuthority,
        custody: {
          signal: new AbortController().signal,
          assertCurrent() {},
          run: (work) => work(),
          release: () => {
            requesterAuthority?.release();
            closed.resolve();
          },
        },
      });
      completion.markAccepted("owner-proof-child");
      const context = makeContext();
      mocks.agentCommand.mockImplementation(async (opts: AgentCommandGatewayIngressOpts) => {
        const runId = opts.runId!;
        const admission = prepareAgentCommandExecutionIdentity({
          opts,
          prepared: {
            cfg: config,
            runId,
            sessionAgentId: "main",
            sessionId: SESSION_ID,
            sessionKey: SESSION,
          },
          ingress: { kind: "gateway-client", boundary: "agent", state: "present" },
          lifecycleGeneration: opts.lifecycleGeneration!,
        });
        try {
          const admitted = await admission.admit("embedded");
          // The provider fixture replaces command execution, including its session-preparation publication.
          registerAgentRunContext(runId, {
            agentId: "main",
            sessionKey: SESSION,
            sessionId: SESSION_ID,
          });
          const identity = createAdmittedGatewayToolCallerIdentity({
            admittedRunContext: admitted,
            agentId: "main",
            sessionKey: SESSION,
          });
          const execute = () =>
            withGatewayToolCallerIdentity(identity, async () => {
              const ownerContinuation = bindRequesterOwnerIdentity({
                runId,
                sessionKey: SESSION,
                sessionId: SESSION_ID,
                agentId: "main",
              });
              const builder = createPluginRegistry({
                logger: { info() {}, warn() {}, error() {}, debug() {} },
                runtime: createPluginRuntimeMock(),
                activateGlobalSideEffects: false,
              });
              const record = createPluginRecord({
                id: "owner-probe",
                contracts: { tools: ["owner_probe"] },
              });
              builder.registry.plugins.push(record);
              builder.createApi(record, { config, registrationMode: "full" }).registerTool(
                {
                  contextVersion: 2,
                  create: (ctx) => ({
                    name: "owner_probe",
                    label: "Owner probe",
                    description: "Isolated owner effect",
                    parameters: { type: "object", properties: {} },
                    async execute() {
                      if (!ctx.senderIsOwner) {
                        throw new Error("owner_authority_required");
                      }
                      effectStarted = true;
                      entered.resolve();
                      await releaseEffect.promise;
                      ctx.assertInvocationCurrent();
                      writeFileSync(output, "authorized owner effect");
                      return { content: [], details: {} };
                    },
                  }),
                },
                { name: "owner_probe" },
              );
              const entry = builder.registry.tools[0]!;
              const ctx = createPluginToolFactoryContext({
                entry,
                registry: builder.registry,
                context: { senderIsOwner: false, sessionKey: SESSION, sessionId: SESSION_ID },
                ownerContinuation,
                assertInvocationCurrent: captureGatewayToolCallerAssertion(),
              });
              const raw = entry.factory(ctx);
              if (!raw || Array.isArray(raw)) {
                throw new Error("expected one owner probe");
              }
              await bindPluginToolCallbacks(
                entry,
                builder.registry,
                raw,
                ctx.assertInvocationCurrent,
              ).execute("owner-proof", {});
            });
          await execute();
        } catch (error) {
          pluginError = error;
        } finally {
          await admission.finish();
          entered.resolve();
        }
        return { payloads: [{ text: "owner proof settled" }], meta: { durationMs: 1 } };
      });
      const delayedDispatch =
        outcome === "observer error before dispatch" || outcome === "cancel before dispatch";
      if (delayedDispatch) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
      const gatewayCall: AgentToolGatewayRequestCaller = async <T>(
        request: Parameters<AgentToolGatewayRequestCaller>[0],
      ) => {
        request.assertDispatchCurrent?.();
        const rpcParams = request.params;
        if (!isRecord(rpcParams)) {
          throw new Error("Expected Gateway RPC parameters");
        }
        if (request.method === "agent") {
          const respond = vi.fn<RespondFn>((ok, payload) => {
            if (!ok || (isRecord(payload) && payload.status !== "accepted")) {
              parentSettled.resolve();
            }
          });
          await invokeAgent(rpcParams, {
            client,
            context,
            respond,
            flushDispatch: !delayedDispatch,
          });
          const [ok, payload, error] = respond.mock.calls[0] ?? [];
          if (!ok) {
            gatewayError = error;
            throw new Error(JSON.stringify(error));
          }
          return payload as T;
        }
        if (request.method !== "agent.wait") {
          throw new Error("unexpected Gateway method");
        }
        if (outcome === "observer error" || delayedDispatch) {
          throw new Error("gateway closed (1006): simulated transport loss");
        }
        const reply = createDeferredCore<T>();
        await agentHandlers["agent.wait"]!({
          params: rpcParams,
          req: { type: "req", id: "owner-proof-wait", method: "agent.wait" },
          context,
          client,
          isWebchatConnect: () => false,
          respond: (ok, payload, error) => {
            if (ok) {
              reply.resolve(payload as T);
            } else {
              reply.reject(new Error(JSON.stringify(error)));
            }
          },
        });
        return await reply.promise;
      };
      try {
        startSessionsSendReplyFlow({
          completion,
          callGateway: gatewayCall,
          runId: "owner-proof-child",
          skip: false,
          reply: { status: "ok", replyText: "ready" },
          notifyRequesterOnWaitFailure: true,
          targetSessionKey: CHILD,
          targetAgentId: "main",
          displayKey: CHILD,
          requesterSessionKey: SESSION,
          requesterAgentId: "main",
          message: "continue authorized task",
          announceTimeoutMs: 1000,
          maxPingPongTurns: 0,
          replyMode: "one-way",
        });
        if (delayedDispatch) {
          await closed.promise;
          expect(authorityReleased).toBe(false);
          expect(effectStarted).toBe(false);
          if (outcome === "cancel before dispatch") {
            for (const entry of context.chatAbortControllers.values()) {
              entry.controller.abort();
            }
          }
          await vi.runOnlyPendingTimersAsync();
        }
        if (outcome !== "cancel before dispatch") {
          await Promise.race([entered.promise, parentSettled.promise]);
        }
        expect(
          effectStarted,
          JSON.stringify({
            pluginError: String(pluginError),
            gatewayError,
            commands: mocks.agentCommand.mock.calls.length,
          }),
        ).toBe(outcome !== "cancel before dispatch");
        expect(existsSync(output)).toBe(false);
        if (outcome === "observer error") {
          await closed.promise;
        }
      } finally {
        releaseEffect.resolve();
        await closed.promise;
        await parentSettled.promise;
        await authorityRetired.promise;
      }
      expect(authorityReleased).toBe(true);
      if (outcome === "cancel before dispatch") {
        expect(mocks.agentCommand).not.toHaveBeenCalled();
        expect(existsSync(output)).toBe(false);
      } else {
        expect(pluginError).toBeUndefined();
        expect(readFileSync(output, "utf8")).toBe("authorized owner effect");
      }
    },
  );
});
