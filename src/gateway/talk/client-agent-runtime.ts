import type {
  AdmittedRunContext,
  OperationalRunInstanceRef,
} from "../../agents/admitted-run-context.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { drainAgentRunTerminalWrites } from "../../infra/agent-run-terminal-writes.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import {
  getRpcSourceForGateway,
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import type { TalkClientRunAuthority } from "./client-run-authority.js";
import { isTalkConsultSourceCurrent } from "./run-ownership.js";

const loadTalkAgentExecution = createLazyRuntimeModule(async () => {
  const [agentCommand, admission, admissionFacts, runtime, dispatch] = await Promise.all([
    import("../../agents/agent-command.js"),
    import("../../agents/admitted-run-context.js"),
    import("../../agents/agent-command-admission-facts.js"),
    import("../../runtime.js"),
    import("./client-agent-runtime-dispatch.js"),
  ]);
  return {
    agentCommandFromGatewayIngress: agentCommand.agentCommandFromGatewayIngress,
    attachAgentCommandAdmissionFacts: admissionFacts.attachAgentCommandAdmissionFacts,
    closeAdmittedRunDelegatedAuthority: admission.closeAdmittedRunDelegatedAuthority,
    createOperationalRunInstanceRef: admission.createOperationalRunInstanceRef,
    defaultRuntime: runtime.defaultRuntime,
    withTalkConsultPublishedRuntime: dispatch.withTalkConsultPublishedRuntime,
  };
});

export function createTalkClientAgentRuntime(params: {
  config: OpenClawConfig;
  getPreparedSessionEntry?: () => SessionEntry | undefined;
  resolveGatewayContext?: GatewayContextResolver;
  rawSourceRef?: string;
  /** Present only when this consultation registers an exact source before execution. */
  getRegisteredSource?: () => RpcSourceRef | undefined;
  runAuthority?: TalkClientRunAuthority;
  assertCurrent?: () => void;
  bindOperationalRunInstance?: (instance: OperationalRunInstanceRef) => void;
  onCommandCompleted?: (instance: OperationalRunInstanceRef) => void;
}) {
  const agentRuntime = createPluginRuntime().agent;
  if (params.assertCurrent) {
    const assertCurrent = params.assertCurrent;
    const preparePatch = agentRuntime.session.prepareSessionEntryPatch;
    agentRuntime.session.prepareSessionEntryPatch = (request) => {
      const authority = request.authority;
      return preparePatch({
        ...request,
        // Consult metadata commits before backend registration. Carry its live
        // admission through storage preparation to the existing commit guard.
        authority:
          authority?.kind === "host"
            ? {
                kind: "host",
                assertCurrent: () => {
                  assertCurrent();
                  authority.assertCurrent();
                },
              }
            : authority,
      });
    };
  }
  let sourceAcquired = false;
  const runEmbeddedAgent: typeof agentRuntime.runEmbeddedAgent = async (requestedParams) => {
    const { agentId, sessionId, sessionKey, storePath } = requestedParams.sessionTarget ?? {};
    if (!agentId || !sessionId || !sessionKey || !storePath) {
      throw new Error("Talk consult requires its prepared transcript target");
    }
    if (params.getRegisteredSource && sourceAcquired) {
      throw new Error("Talk consultation source has already been acquired");
    }
    const source = params.getRegisteredSource?.();
    if ((params.getRegisteredSource || params.rawSourceRef) && !source) {
      throw new Error("Talk consultation source registration is unavailable");
    }
    const lifecycleGeneration = source && getRpcSourceLifecycleGeneration(source);
    const assertSourceCurrent = () => {
      if (!source) {
        return;
      }
      const identity = getRpcSourceIdentity(source);
      if (
        params.getRegisteredSource?.() !== source ||
        source.input.protocolRunId !== requestedParams.runId ||
        getRpcSourceForGateway(requestedParams.runId, params.resolveGatewayContext) !== source ||
        source.input.target?.storeScope !== storePath ||
        identity.agentId !== agentId ||
        !params.rawSourceRef ||
        !isTalkConsultSourceCurrent({
          entry: source,
          connectionId: params.rawSourceRef,
          sessionId,
          sessionKey,
          lifecycleGeneration,
          phase: "active",
        })
      ) {
        throw new Error("Talk consultation source registration is no longer current");
      }
      source.adapter.authority?.assertCurrent();
    };
    params.assertCurrent?.();
    assertSourceCurrent();
    // One execution consumes this consultation's registration, never a later retry.
    sourceAcquired = params.getRegisteredSource !== undefined;
    return await withSessionTurn(
      {
        sessionKey,
        sessionId,
        agentId,
        storePath,
        controllerInput: source?.input,
        abortSignal: requestedParams.abortSignal,
      },
      async (_operation, abortSignal) => {
        const runParams = { ...requestedParams, abortSignal };
        runParams.abortSignal?.throwIfAborted();
        const config = runParams.config ?? params.config;
        params.assertCurrent?.();
        assertSourceCurrent();
        const retained = await params.runAuthority?.retainRun(runParams.runId);
        try {
          runParams.abortSignal?.throwIfAborted();
          const execution = await loadTalkAgentExecution();
          runParams.abortSignal?.throwIfAborted();
          // Accepted work outlives audio transport; the source and retained run authority govern it.
          assertSourceCurrent();
          const operationalRunInstance = execution.createOperationalRunInstanceRef(runParams.runId);
          retained?.assertSourceCurrent();
          params.bindOperationalRunInstance?.(operationalRunInstance);
          // Voice is a turn of the same chat: the command owner selects the session's own
          // runtime (Claude CLI, native harness or embedded) exactly as for a typed turn.
          const runContext = {
            messageChannel: runParams.messageProvider,
            accountId: runParams.agentAccountId,
            currentChannelId: runParams.currentChannelId,
            currentThreadTs: runParams.currentThreadTs,
            senderId: runParams.senderId,
          };
          execution.attachAgentCommandAdmissionFacts(runContext, {
            ingress: {
              kind: "gateway-client",
              boundary: "talk-agent-consult",
              state: "present",
              ...(params.rawSourceRef ? { rawSourceRef: params.rawSourceRef } : {}),
            },
          });
          // Abort revokes delegated authority at once, independently of command completion.
          let admitted: AdmittedRunContext | undefined;
          const revoke = () => {
            if (admitted) {
              execution.closeAdmittedRunDelegatedAuthority(admitted);
            }
          };
          runParams.abortSignal?.addEventListener("abort", revoke, { once: true });
          try {
            runParams.abortSignal?.throwIfAborted();
            // Provider-owned work can outlive or replace its audio transport. Unlike
            // chat-backed Talk, it has no independent Chat terminal delivery; hiding
            // its final transcript would lose the answer when no spoken replacement arrives.
            const result = await execution.withTalkConsultPublishedRuntime(
              {
                agentId,
                sessionKey,
                sessionEntry: params.getPreparedSessionEntry?.(),
                workspaceDir: runParams.workspaceDir,
                abortSignal: runParams.abortSignal,
              },
              (runtimeContext) =>
                execution.agentCommandFromGatewayIngress(
                  {
                    message: runParams.prompt,
                    agentId,
                    sessionKey,
                    sessionId,
                    runId: runParams.runId,
                    // Chat turns run a pinned session worktree as their workspace, not only as cwd.
                    workspaceDir: runParams.workspaceDir,
                    cwd: runParams.cwd,
                    lane: runParams.lane,
                    extraSystemPrompt: runParams.extraSystemPrompt,
                    // Per-run only: `thinking`/`verbose` would persist onto the chat session.
                    thinkingOnce: runParams.thinkLevel,
                    // Talk settings are machine preferences, as in chat-backed Talk (#194184).
                    normalizeThinkingLevelOverride: runParams.thinkLevel !== undefined,
                    fastMode: runParams.fastMode,
                    timeout: String(Math.max(1, Math.ceil(runParams.timeoutMs / 1000))),
                    deliver: false,
                    bestEffortDeliver: false,
                    // The voice consult uses the chat's selected model; it carries no override.
                    allowModelOverride: false,
                    messageChannel: runParams.messageProvider,
                    messageProvider: runParams.messageProvider,
                    senderIsOwner: runParams.senderIsOwner === true,
                    toolsAllow: runParams.toolsAllow,
                    toolBindings: runParams.toolBindings,
                    clientCaps: runParams.clientCaps,
                    approvalReviewerDeviceId: runParams.approvalReviewerDeviceId,
                    bashElevated: runParams.bashElevated,
                    runContext,
                    abortSignal: runParams.abortSignal,
                    operationalRunInstance,
                    operatorAuthority: retained?.authority,
                    assertSourceCurrent: retained?.assertSourceCurrent,
                    onAdmittedRunContext: (context) => {
                      admitted = context;
                      // Closes the admission-to-listener race.
                      if (runParams.abortSignal?.aborted) {
                        revoke();
                      }
                    },
                    // Speech is mirrored separately. Keep generated input in current-turn custody,
                    // but never display it or replay it as a later user request.
                    userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
                      sessionLifecyclePatch: { lastInteractionAt: Date.now() },
                      input: {
                        text: runParams.prompt,
                        display: false,
                        excludeFromContext: true,
                        idempotencyKey: buildRunUserTurnIdempotencyKey(runParams.runId),
                      },
                      target: {
                        agentId,
                        sessionId,
                        sessionKey,
                        storePath,
                        expectedSessionId: sessionId,
                        sessionEntry: undefined,
                        config,
                        cwd: runParams.workspaceDir,
                      },
                    }),
                  },
                  execution.defaultRuntime,
                  // The command owner resolves its default dependencies lazily.
                  undefined,
                  runtimeContext,
                ),
            );
            if (!result) {
              throw new Error("Talk consult produced no agent result");
            }
            // Completion is a command-owner fact, independent of the selected backend's
            // embedded attachment. Accepted terminal writes must settle before publication.
            await drainAgentRunTerminalWrites(operationalRunInstance);
            runParams.abortSignal?.throwIfAborted();
            const receipt = result.meta.agentMeta?.terminalReceipt;
            if (
              !result.meta.aborted &&
              !result.meta.yielded &&
              !result.meta.error &&
              result.meta.stopReason !== "error" &&
              result.meta.terminalReply?.disposition === "visible" &&
              (!receipt ||
                (receipt.runId === operationalRunInstance.runId && receipt.sessionId === sessionId))
            ) {
              params.onCommandCompleted?.(operationalRunInstance);
            }
            return result as unknown as Awaited<ReturnType<typeof agentRuntime.runEmbeddedAgent>>;
          } finally {
            // The command owner closes its admission; join accepted terminal writes here too.
            try {
              await drainAgentRunTerminalWrites(operationalRunInstance);
            } finally {
              runParams.abortSignal?.removeEventListener("abort", revoke);
            }
          }
        } finally {
          retained?.release();
        }
      },
    );
  };
  Object.defineProperty(agentRuntime, "runEmbeddedAgent", {
    configurable: true,
    enumerable: true,
    value: runEmbeddedAgent,
  });
  return agentRuntime;
}
