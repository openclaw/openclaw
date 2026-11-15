import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
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
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { collectRealtimeVoiceAgentConsultVisibleText } from "../../talk/agent-consult-tool.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import type { TalkClientRunAuthority } from "./client-run-authority.js";
import { isTalkConsultSourceCurrent } from "./run-ownership.js";

const loadTalkAgentExecution = createLazyRuntimeModule(async () => {
  const [embeddedAgent, admission, sessions, context, transcript] = await Promise.all([
    import("../../agents/embedded-agent.js"),
    import("../../agents/admitted-run-context.js"),
    import("../../agents/sessions/session-manager.js"),
    import("../../agents/embedded-agent-runner/run/session-context-limits.js"),
    import("../../config/sessions/session-accessor.js"),
  ]);
  return {
    runEmbeddedAgent: embeddedAgent.runEmbeddedAgent,
    createOperationalRunInstanceRef: admission.createOperationalRunInstanceRef,
    prepareAgentRunAdmission: admission.prepareAgentRunAdmission,
    SessionManager: sessions.SessionManager,
    resolveContextLimits: context.resolveEmbeddedSessionContextLimits,
    appendResult: transcript.persistSessionTranscriptTurn,
  };
});

export function createTalkClientAgentRuntime(params: {
  config: OpenClawConfig;
  resolveGatewayContext?: GatewayContextResolver;
  rawSourceRef?: string;
  /** Present only when this consultation registers an exact source before execution. */
  getRegisteredSource?: () => RpcSourceRef | undefined;
  runAuthority?: TalkClientRunAuthority;
  assertCurrent?: () => void;
  bindOperationalRunInstance?: (instance: OperationalRunInstanceRef) => void;
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
      async (replyOperation, abortSignal) => {
        const runParams = { ...requestedParams, replyOperation, abortSignal };
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
          const preparedRunAdmission = execution.prepareAgentRunAdmission({
            cfg: config,
            operationalRunInstance,
            assertSourceCurrent: retained?.assertSourceCurrent,
            operatorAuthority: retained?.authority,
            facts: {
              runId: runParams.runId,
              agentId,
              ingress: {
                kind: "gateway-client",
                boundary: "talk-agent-consult",
                state: "present",
                ...(params.rawSourceRef ? { rawSourceRef: params.rawSourceRef } : {}),
              },
            },
          });
          let closed = false;
          const close = () => {
            if (!closed) {
              closed = true;
              preparedRunAdmission.close();
            }
          };
          // Abort owns authority revocation independently of core completion; the
          // post-registration check closes the prepare-to-listener race.
          runParams.abortSignal?.addEventListener("abort", close, { once: true });
          try {
            runParams.abortSignal?.throwIfAborted();
            // The consult reads the conversation, but its generated input and tool loop
            // belong to this detached context. Only its completed answer joins the source.
            const sessionManager = await execution.SessionManager.openModelContextAsync(
              { agentId, sessionId, sessionKey, storePath },
              {
                cwd: runParams.workspaceDir,
                signal: runParams.abortSignal,
                limits: execution.resolveContextLimits(runParams),
              },
            );
            const result = await execution.runEmbeddedAgent({
              ...runParams,
              preparedRunAdmission,
              sessionManager,
              sessionPersistence: "detached",
              promptCacheKey: `${sessionKey}:talk-consult:${runParams.runId}`,
            });
            if (!runParams.abortSignal?.aborted && !result.meta.aborted && !result.meta.yielded) {
              const text = collectRealtimeVoiceAgentConsultVisibleText(
                (result.payloads ?? []).filter(
                  (payload) => getReplyPayloadMetadata(payload)?.precedingInputAnswer !== true,
                ),
              );
              if (text) {
                const appended = await execution.appendResult(
                  { agentId, sessionId, sessionKey, storePath },
                  {
                    expectedSessionId: sessionId,
                    config,
                    assertCurrent: assertSourceCurrent,
                    runId: runParams.runId,
                    updateMode: "inline",
                    touchSessionEntry: true,
                    messages: [
                      {
                        message: {
                          role: "assistant",
                          content: [{ type: "text", text }],
                          timestamp: Date.now(),
                          stopReason: "stop",
                          provider: result.meta.agentMeta?.provider,
                          model: result.meta.agentMeta?.model,
                          usage: result.meta.agentMeta?.usage,
                          idempotencyKey: `talk-consult-result:${runParams.runId}`,
                        },
                        idempotencyLookup: "scan-assistant",
                        useRawWhenLinear: true,
                      },
                    ],
                  },
                );
                if (appended.rejectedReason) {
                  throw new Error(
                    `Talk consult result could not be saved: ${appended.rejectedReason}`,
                  );
                }
              }
            }
            return result;
          } finally {
            // Accepted terminal writes commit under this admission; abort still closes it immediately.
            try {
              await drainAgentRunTerminalWrites(operationalRunInstance);
            } finally {
              runParams.abortSignal?.removeEventListener("abort", close);
              close();
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
