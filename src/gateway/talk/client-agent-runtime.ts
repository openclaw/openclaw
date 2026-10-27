import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
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
  const [embeddedAgent, admission] = await Promise.all([
    import("../../agents/embedded-agent.js"),
    import("../../agents/admitted-run-context.js"),
  ]);
  return {
    runEmbeddedAgent: embeddedAgent.runEmbeddedAgent,
    createOperationalRunInstanceRef: admission.createOperationalRunInstanceRef,
    prepareAgentRunAdmission: admission.prepareAgentRunAdmission,
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
        const retained = await params.runAuthority?.retainRun(
          runParams.runId,
          runParams.spawnedBy ?? undefined,
        );
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
            // Provider-owned work can outlive or replace its audio transport. Unlike
            // chat-backed Talk, it has no independent Chat terminal delivery; hiding
            // its final transcript would lose the answer when no spoken replacement arrives.
            return await execution.runEmbeddedAgent({
              ...runParams,
              preparedRunAdmission,
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
            });
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
