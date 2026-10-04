// Keep shared fixture mock registration before the production imports.
// oxfmt-ignore
import {
  describe1AfterEach1,
  describe1BeforeEach0,
  getAgentTestMocks,
  makeContext,
  prime,
} from "./agent.test-harness.js";
// Provider/session fixtures are isolated; RPC admission, authority, and plugin effects are real.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { prepareAgentCommandExecutionIdentity } from "../../agents/agent-command-execution-identity.js";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import type { AgentCommandGatewayIngressOpts } from "../../agents/command/types.js";
import {
  bindRequesterOwnerIdentity,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import * as completionDelivery from "../../agents/subagents/announce/subagent-announce-completion-delivery.js";
import { SessionFollowupCompletion } from "../../agents/subagents/completion/session-followup-completion.js";
import {
  captureRequesterFollowupAuthority,
  admitRequesterCronAuthorityUserTurn,
} from "../../agents/subagents/requester-cron-authority.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  captureGatewayToolCallerAssertion,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
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
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createPluginToolFactoryContext } from "../../plugins/tool-factory-context.js";
import { bindPluginToolCallbacks } from "../../plugins/tool-factory-runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { abortChatRunById } from "../chat-abort.js";
import { createContext as createInProcessContext } from "../server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";

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
    admitRequesterCronAuthorityUserTurn({ sessionKey: SESSION });
    await describe1AfterEach1();
  });

  it.for(["observer error", "observer error before dispatch", "cancel before dispatch"] as const)(
    "checks %s after RPC admission and before a versioned plugin writes",
    async (outcome, { signal }) => {
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
      const accepted = createDeferredCore();
      const entered = createDeferredCore();
      const releaseEffect = createDeferredCore();
      let pluginError: unknown;
      let effectStarted = false;
      let continuation: Promise<unknown> | undefined;
      const context = Object.assign(createInProcessContext(), makeContext());
      const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
      const parentRunId = "announce:sessions-send:owner-proof-child:completion";
      const dispatch = completionDelivery.runAnnounceAgentCall;
      const observeAdmission = vi
        .spyOn(completionDelivery, "runAnnounceAgentCall")
        .mockImplementation((params) =>
          dispatch({
            ...params,
            onAccepted: (receipt) => {
              params.onAccepted?.(receipt);
              accepted.resolve();
            },
          }),
        );
      const stageInput = mocks.stageSessionPendingInput.getMockImplementation();
      if (!stageInput) {
        throw new Error("Expected the in-memory session input fixture");
      }
      mocks.stageSessionPendingInput.mockImplementation(async (scope, options) => {
        const input = await stageInput(scope, options);
        return input
          ? {
              ...input,
              completeAsync: async (terminal: AgentRunTerminalOutcome) => {
                options.assertCompletionCurrent?.();
                return terminal;
              },
            }
          : undefined;
      });
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
          run: (work) => {
            const result = withPluginRuntimeGatewayRequestScope(
              {
                context,
                client,
                resolveGatewayContext: () => context,
                isWebchatConnect: () => false,
              },
              work,
            );
            continuation = Promise.resolve(result);
            return result;
          },
          release: () => {
            requesterAuthority?.release();
            closed.resolve();
          },
        },
      });
      completion.markAccepted("owner-proof-child");
      mocks.agentCommand.mockImplementation(async (opts: AgentCommandGatewayIngressOpts) => {
        const runId = opts.runId!;
        await opts.userTurnTranscriptRecorder?.persistApproved();
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
      try {
        await startSessionsSendReplyFlow({
          completion,
          runId: "owner-proof-child",
          skip: false,
          reply: { status: "ok", replyText: "ready" },
          notifyRequesterOnWaitFailure: true,
          targetSessionKey: CHILD,
          targetAgentId: "main",
          displayKey: CHILD,
          requesterSessionKey: SESSION,
          requesterAgentId: "main",
          replyTimeoutMs: 1000,
          replyMode: "one-way",
        });
        if (!continuation) {
          throw new Error("Expected retained native completion work");
        }
        const settled = continuation.catch(() => undefined);
        await withinTest(
          awaitGateBeforeSettlement(
            accepted.promise,
            settled,
            "Parent ended before native private admission",
          ),
          signal,
        );
        if (delayedDispatch) {
          expect(authorityReleased).toBe(false);
          expect(effectStarted).toBe(false);
          if (outcome === "cancel before dispatch") {
            expect(
              abortChatRunById(context, {
                runId: parentRunId,
                sessionKey: SESSION,
                stopReason: "rpc",
              }).aborted,
            ).toBe(true);
          } else {
            completion.close(new Error("simulated observer loss before execution"));
            expect(authorityReleased).toBe(false);
          }
          // Cross the native accepted-ack yield without advancing run deadlines.
          await vi.advanceTimersByTimeAsync(10);
        }
        if (outcome !== "cancel before dispatch") {
          await withinTest(
            awaitGateBeforeSettlement(entered.promise, settled, "Parent ended before plugin entry"),
            signal,
          );
        }
        expect(
          effectStarted,
          JSON.stringify({
            pluginError: String(pluginError),
            commands: mocks.agentCommand.mock.calls.length,
          }),
        ).toBe(outcome !== "cancel before dispatch");
        expect(existsSync(output)).toBe(false);
        if (outcome === "observer error") {
          completion.close(new Error("simulated observer loss during execution"));
          expect(authorityReleased).toBe(false);
        }
      } finally {
        try {
          releaseEffect.resolve();
          if (vi.isFakeTimers()) {
            await vi.advanceTimersByTimeAsync(10);
          }
          if (continuation) {
            await withinTest(
              continuation.catch(() => undefined),
              signal,
            );
          }
          await withinTest(closed.promise, signal);
          await withinTest(authorityRetired.promise, signal);
        } finally {
          observeAdmission.mockRestore();
          vi.useRealTimers();
        }
      }
      expect(authorityReleased).toBe(true);
      if (outcome === "cancel before dispatch") {
        expect(mocks.agentCommand).not.toHaveBeenCalled();
        expect(existsSync(output)).toBe(false);
      } else {
        expect(mocks.agentCommand).toHaveBeenCalledOnce();
        expect(pluginError).toBeUndefined();
        expect(readFileSync(output, "utf8")).toBe("authorized owner effect");
        expect(context.dedupe.get(`agent:${parentRunId}`)?.payload).toMatchObject({
          status: "ok",
          inputProcessingCompleted: true,
        });
      }
    },
  );
});
