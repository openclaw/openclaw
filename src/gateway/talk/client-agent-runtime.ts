import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { OPENCLAW_AGENT_RUNTIME_ID } from "../../agents/agent-runtime-id.js";
import type { SessionMaintenanceRequest } from "../../agents/session-maintenance/run.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureAgentRunLifecycleGeneration } from "../../infra/agent-events.js";
import { drainAgentRunTerminalWrites } from "../../infra/agent-run-terminal-writes.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { getRpcSourceForGateway } from "../../sessions/session-controller.rpc-sources.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { runOutsideAsyncWorkScope } from "../../shared/async-work-scope.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import type { TalkClientRunAuthority } from "./client-run-authority.js";

const loadTalkAgentExecution = createLazyRuntimeModule(async () => {
  const [embeddedAgent, admission, maintenance, catalog] = await Promise.all([
    import("../../agents/embedded-agent.js"),
    import("../../agents/admitted-run-context.js"),
    import("../../agents/session-maintenance/run.js"),
    import("../../agents/model-catalog.runtime.js"),
  ]);
  return {
    runEmbeddedAgent: embeddedAgent.runEmbeddedAgent,
    loadProviderScopedThinkingCatalog: catalog.loadProviderScopedThinkingCatalog,
    createSessionMaintenanceFollowup: maintenance.createSessionMaintenanceFollowup,
    scheduleSessionMaintenance: maintenance.scheduleSessionMaintenance,
    createOperationalRunInstanceRef: admission.createOperationalRunInstanceRef,
    prepareAgentRunAdmission: admission.prepareAgentRunAdmission,
  };
});

export function createTalkClientAgentRuntime(params: {
  config: OpenClawConfig;
  resolveGatewayContext?: GatewayContextResolver;
  rawSourceRef?: string;
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
  const runEmbeddedAgent: typeof agentRuntime.runEmbeddedAgent = async (requestedParams) => {
    const { agentId, sessionId, sessionKey, storePath } = requestedParams.sessionTarget ?? {};
    if (!agentId || !sessionId || !sessionKey || !storePath) {
      throw new Error("Talk consult requires its prepared transcript target");
    }
    const source = getRpcSourceForGateway(requestedParams.runId, params.resolveGatewayContext);
    params.assertCurrent?.();
    let scheduleMaintenance: (() => void) | undefined;
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
        const retained = await params.runAuthority?.retainRun(runParams.runId);
        try {
          runParams.abortSignal?.throwIfAborted();
          const execution = await loadTalkAgentExecution();
          runParams.abortSignal?.throwIfAborted();
          // Accepted work outlives audio transport; the source and retained run authority govern it.
          if (
            source &&
            getRpcSourceForGateway(runParams.runId, params.resolveGatewayContext) !== source
          ) {
            throw new Error("Talk source changed during runtime preparation");
          }
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
            const startedAt = Date.now();
            const lifecycleGeneration = captureAgentRunLifecycleGeneration(runParams.runId);
            let auth: { authProfileId?: string; authProfileIdSource?: "auto" | "user" } | undefined;
            let compactionRequestBudget: SessionMaintenanceRequest["compactionRequestBudget"];
            const result = await execution.runEmbeddedAgent({
              ...runParams,
              preparedRunAdmission,
              // Consults have no reply pipeline, so they own the post-turn upkeep typed turns get.
              onSuccessfulAuthProfile: (authProfileId) => {
                auth = { authProfileId };
              },
              onCompactionRequestBudget: (budget) => {
                compactionRequestBudget = budget;
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
            });
            const agentMeta = result.meta?.agentMeta;
            const { agentDir } = runParams;
            if (
              auth &&
              agentDir &&
              agentMeta?.agentHarnessId === OPENCLAW_AGENT_RUNTIME_ID &&
              !agentMeta.compactionCount &&
              !result.meta?.aborted &&
              !result.meta?.yielded &&
              !result.meta?.error &&
              !result.payloads?.some((payload) => payload.isError) &&
              config.agents?.defaults?.compaction?.enabled !== false
            ) {
              // Read while the turn is admitted: its revision and catalog fence the upkeep.
              // Optional preparation must never replace the completed consult's answer.
              const entry = await agentRuntime.session
                .getSessionEntryAsync({ agentId, storePath, sessionKey, readConsistency: "latest" })
                .catch(() => undefined);
              if (entry?.sessionId === sessionId) {
                // Maintenance budgets the completed route's window from its admitted catalog.
                const thinkingCatalog = await execution
                  .loadProviderScopedThinkingCatalog({
                    config,
                    provider: agentMeta.provider,
                    model: agentMeta.model,
                    agentRuntime: OPENCLAW_AGENT_RUNTIME_ID,
                    agentId,
                    agentDir,
                    workspaceDir: runParams.workspaceDir,
                  })
                  .catch(() => undefined);
                const request: SessionMaintenanceRequest = {
                  prepared: { cfg: config, sessionKey, storePath, timeoutMs: runParams.timeoutMs },
                  followupRun: execution.createSessionMaintenanceFollowup({
                    run: {
                      agentId,
                      agentDir,
                      workspaceDir: runParams.workspaceDir,
                      cwd: runParams.cwd,
                      messageProvider: runParams.messageProvider,
                      agentAccountId: runParams.agentAccountId,
                      thinkLevel: runParams.thinkLevel,
                      thinkingCatalog,
                      verboseLevel: "off",
                      timeoutMs: runParams.timeoutMs,
                      senderIsOwner: runParams.senderIsOwner,
                      conversationToolPolicy: runParams.conversationToolPolicy,
                    },
                    sessionEntry: entry,
                    cfg: config,
                    sessionKey,
                    provider: agentMeta.provider,
                    model: agentMeta.model,
                    auth: {
                      authProfileId: auth.authProfileId,
                      authProfileIdSource: auth.authProfileId
                        ? auth.authProfileId === entry.authProfileOverride?.trim()
                          ? resolveCollapsedSessionAuthPinSource(entry)
                          : "auto"
                        : undefined,
                    },
                  }),
                  sessionId,
                  lifecycleRevision: entry.lifecycleRevision,
                  lifecycleGeneration,
                  startedAt,
                  agentHarnessId: agentMeta.agentHarnessId,
                  compactionRequestBudget,
                };
                // The consult's work scope closes when it returns; upkeep owns its own root.
                scheduleMaintenance = () =>
                  runOutsideAsyncWorkScope(() => execution.scheduleSessionMaintenance(request));
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
    ).finally(() => scheduleMaintenance?.());
  };
  Object.defineProperty(agentRuntime, "runEmbeddedAgent", {
    configurable: true,
    enumerable: true,
    value: runEmbeddedAgent,
  });
  return agentRuntime;
}
