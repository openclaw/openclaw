import {
  resolvePreparedRunAdmission,
  type PreparedAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { resolveAgentDir, resolveRunModelFallbacksOverride } from "../../agents/agent-scope.js";
import { resolveCliBackendConfig } from "../../agents/cli-backends.js";
import {
  cliBackendAcceptsAuthProfileForwarding,
  resolveCliExecutionAuthProfileId,
} from "../../agents/cli-execution-auth.js";
import { buildCliMcpDelegationCapabilityBinding } from "../../agents/cli-runner/mcp-grant-context.js";
import {
  buildCliSessionForkRunParams,
  clearCliSessionInStore,
} from "../../agents/cli-session-store.js";
import {
  getCliSessionBinding,
  shouldClearFailedCliSessionBinding,
} from "../../agents/cli-session.js";
import { resolveDelegationCapability } from "../../agents/delegation-capability.js";
import { withAdmittedCliCandidate } from "../../agents/embedded-agent-runner/run-entry-cli.js";
import { resolveRunEntryCliRuntime } from "../../agents/embedded-agent-runner/run-entry-runtime.js";
import { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import { createDeferredEmbeddedRunLifecycleManager } from "../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { resolveInitialEmbeddedRunModel } from "../../agents/embedded-agent-runner/run/runtime-resolution.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import {
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
} from "../../agents/media-generation-activity.js";
import { resolveAgentRunErrorLifecycleFields } from "../../agents/run-termination.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { createAgentLifecycleTerminalBackstop } from "../../auto-reply/reply/agent-lifecycle-terminal.js";
import { runCliAgentWithLifecycle } from "../../auto-reply/reply/agent-runner-cli-dispatch.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildGenericCliContextEngineHostSupport } from "../../context-engine/host-compat.js";
import { captureAgentRunLifecycleGeneration, emitAgentEvent } from "../../infra/agent-events.js";
import { clearAgentRunTerminalWriteContext } from "../../infra/agent-run-terminal-writes.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import {
  isModelSelectionLocked,
  ModelSelectionLockedError,
} from "../../sessions/model-overrides.js";

type TalkAgentTurnParams = RunEmbeddedAgentInternalParams & {
  config: OpenClawConfig;
  preparedRunAdmission: PreparedAgentRunAdmission;
  sessionTarget: SessionTranscriptRuntimeTarget;
};

/** Browser Talk keeps its admission and transcript custody for the entire configured turn. */
export async function runTalkAgentTurn(params: TalkAgentTurnParams) {
  const { agentId, sessionId, sessionKey, storePath } = params.sessionTarget;
  const assertCurrent = () => {
    params.abortSignal?.throwIfAborted();
    params.preparedRunAdmission.assertSourceCurrent();
  };
  const identity = { agentId, sessionId, sessionKey, runId: params.runId, lane: params.lane };
  let lifecycleGeneration =
    params.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(params.runId);
  const deferredLifecycle = createDeferredEmbeddedRunLifecycleManager({
    ...identity,
    sessionFile: sessionKey,
    abortSignal: params.abortSignal,
  });
  const terminal = createAgentLifecycleTerminalBackstop({
    runId: params.runId,
    sessionKey,
    getLifecycleGeneration: () => lifecycleGeneration,
    resolveTerminationFields: (error) =>
      resolveAgentRunErrorLifecycleFields(error, deferredLifecycle.signal),
  });
  try {
    assertCurrent();
    const sessionEntry = await readSessionEntryInWorker(
      { ...params.sessionTarget, readConsistency: "latest" },
      assertCurrent,
    );
    assertCurrent();
    if (isModelSelectionLocked(sessionEntry)) {
      throw new ModelSelectionLockedError();
    }
    const selection = resolveInitialEmbeddedRunModel({ ...params, agentId });
    const mediaTaskIds = getGeneratedMediaTaskIdsForSessionKey(sessionKey, agentId);
    const resolveRuntime = (provider: string, model: string, runtime?: string) =>
      resolveRunEntryCliRuntime({
        config: params.config,
        provider,
        model,
        agentId,
        authProfileId: params.authProfileId,
        sessionRuntimeOverride: runtime,
        pinnedHarnessId: resolveSessionPinnedHarnessId(sessionEntry),
      });
    const entry = await runEmbeddedAgentEntry({
      preparedRunAdmission: params.preparedRunAdmission,
      selection: {
        cfg: params.config,
        provider: selection.provider,
        model: selection.modelId,
        agentDir: params.agentDir,
        fallbacksOverride:
          params.modelFallbacksOverride ??
          resolveRunModelFallbacksOverride({ cfg: params.config, agentId, sessionKey }),
        userLockedAuthProfileId:
          params.authProfileIdSource === "user" ? params.authProfileId : undefined,
      },
      identity,
      harness: {
        workspaceDir: params.workspaceDir,
        sessionKey,
        preparation: { kind: "direct" },
        resolveRuntimeOverride: (provider) =>
          params.agentHarnessRuntimeOverride ??
          resolveSessionRuntimeOverrideForProvider({
            provider,
            entry: sessionEntry,
            cfg: params.config,
          }),
        resolveContextEngineHost: (provider, model, override) => {
          const runtime = resolveRuntime(provider, model, override);
          if (!runtime.useCliExecution) {
            return undefined;
          }
          const backend = resolveCliBackendConfig(runtime.cliExecutionProvider, params.config, {
            agentId,
          });
          return buildGenericCliContextEngineHostSupport({
            backendId: backend?.id ?? runtime.cliExecutionProvider,
            ...(backend?.contextEngineHostCapabilities
              ? { capabilities: backend.contextEngineHostCapabilities }
              : {}),
          });
        },
      },
      behavior: {
        kind: "command-rpc",
        hasCommittedSideEffect: () =>
          hasNewGeneratedMediaTaskForSessionKey(sessionKey, mediaTaskIds, agentId),
      },
      sessionOverride: { kind: "preserve" },
      abortSignal: deferredLifecycle.signal,
      onFallbackStep: (step) => {
        emitAgentEvent({
          ...identity,
          lifecycleGeneration,
          stream: "lifecycle",
          data: { phase: "fallback_step", ...step },
        });
      },
      runCandidate: async (provider, model, options) => {
        deferredLifecycle.signal.throwIfAborted();
        params.preparedRunAdmission.assertSourceCurrent();
        clearAgentRunTerminalWriteContext(params.preparedRunAdmission.operationalRunInstance);
        const runtime = resolveRuntime(provider, model, options.agentHarnessRuntimeOverride);
        const common = {
          ...params,
          ...identity,
          ...options,
          provider,
          model,
          sessionFile: sessionKey,
          lifecycleGeneration,
          abortSignal: deferredLifecycle.signal,
          suppressNextUserMessagePersistence:
            params.suppressNextUserMessagePersistence === true ||
            params.userTurnTranscriptRecorder?.hasPersisted() === true ||
            params.userTurnTranscriptRecorder?.isBlocked() === true,
        };
        if (!runtime.useCliExecution) {
          return runEmbeddedAgent({
            ...common,
            onExecutionStarted: (info) => {
              if (info?.lifecycleGeneration) {
                lifecycleGeneration = info.lifecycleGeneration;
              }
              return params.onExecutionStarted?.(info);
            },
            deferTerminalLifecycle: true,
            onDeferredLifecycleOwner: deferredLifecycle.adopt,
            onDeferredLifecycleAbort: deferredLifecycle.abort,
            onRetryWait: deferredLifecycle.beginRetryWait,
          });
        }
        return withAdmittedCliCandidate(
          {
            claim: identity,
            admission: {
              preparedRunAdmission: params.preparedRunAdmission,
              lifecycleGeneration,
              isFinalFallbackAttempt: options.isFinalFallbackAttempt,
              abortSignal: deferredLifecycle.signal,
              trigger: params.trigger,
              inputProvenance: params.inputProvenance,
            },
            provider: runtime.cliExecutionProvider,
            sessionTarget: params.sessionTarget,
            expectedLifecycleRevision: sessionEntry?.lifecycleRevision,
            readMode: "read-only",
            getSessionEntry: () => sessionEntry,
            classifyResult: options.classifyResult,
          },
          async ({
            sessionEntry: admittedEntry,
            cliSessionBinding,
            assertSettlementCurrent,
            settleResult,
          }) => {
            const authProfileId = cliBackendAcceptsAuthProfileForwarding({
              provider: runtime.cliExecutionProvider,
              config: params.config,
              agentId,
            })
              ? resolveCliExecutionAuthProfileId({
                  cliExecutionProvider: runtime.cliExecutionProvider,
                  authProfileProvider: provider,
                  config: params.config,
                  agentDir: params.agentDir ?? resolveAgentDir(params.config, agentId),
                  selected: params,
                  sessionBinding: cliSessionBinding,
                })
              : params.authProfileId;
            let currentEntry = admittedEntry;
            const sessionStore = admittedEntry ? { [sessionKey]: admittedEntry } : undefined;
            const fork =
              cliSessionBinding?.sessionId && sessionStore
                ? buildCliSessionForkRunParams(
                    {
                      agentId,
                      provider: runtime.cliExecutionProvider,
                      expectedCliSessionId: cliSessionBinding.sessionId,
                      sessionKey,
                      storePath,
                      sessionStore,
                      assertCommitAllowed: assertSettlementCurrent,
                      abortSignal: deferredLifecycle.signal,
                    },
                    (updatedEntry) => {
                      currentEntry = updatedEntry;
                    },
                  )
                : {};
            const admittedRunContext = await resolvePreparedRunAdmission({
              runId: params.runId,
              runtimeKind: "embedded",
              preparedRunAdmission: params.preparedRunAdmission,
            });
            assertSettlementCurrent();
            let result;
            try {
              result = await withGatewayToolCallerIdentity(
                createAdmittedGatewayToolCallerIdentity({
                  agentId,
                  sessionKey,
                  admittedRunContext,
                }),
                async () =>
                  runCliAgentWithLifecycle({
                    runId: params.runId,
                    lifecycleGeneration,
                    runParams: {
                      ...common,
                      ...fork,
                      onExecutionStarted: () =>
                        params.onExecutionStarted?.({ lifecycleGeneration }),
                      diagnosticOwner: deferredLifecycle.handoffToCli(),
                      runtimePolicySessionKey: params.sandboxSessionKey,
                      ...buildCliMcpDelegationCapabilityBinding(
                        resolveDelegationCapability({
                          fallbackActive: options.isFallbackRetry,
                          inputProvenance: params.inputProvenance,
                          disableTools: params.disableTools,
                          toolsAllow: params.toolsAllow,
                        }),
                      ),
                      provider: runtime.cliExecutionProvider,
                      modelProvider: provider,
                      requesterModel: { provider, model },
                      authProfileId,
                      sessionEntry: admittedEntry,
                      storePath,
                      persistAssistantTranscript: true,
                      cliSessionId: cliSessionBinding?.sessionId,
                      cliSessionBinding,
                      forkCliSessionOnResume: cliSessionBinding?.forkNextResume === true,
                    },
                  }),
              );
            } catch (error) {
              const failedBinding = getCliSessionBinding(
                currentEntry,
                runtime.cliExecutionProvider,
              );
              if (
                runtime.cliExecutionProvider === "claude-cli" &&
                sessionStore &&
                failedBinding?.sessionId &&
                shouldClearFailedCliSessionBinding({
                  error,
                  binding: failedBinding,
                  bindingReplacedDuringRun:
                    failedBinding.sessionId !== cliSessionBinding?.sessionId,
                  hasNewGeneratedMediaTask: hasNewGeneratedMediaTaskForSessionKey(
                    sessionKey,
                    mediaTaskIds,
                    agentId,
                  ),
                })
              ) {
                await clearCliSessionInStore({
                  agentId,
                  provider: runtime.cliExecutionProvider,
                  sessionKey,
                  storePath,
                  sessionStore,
                  expectedCliSessionId: failedBinding.sessionId,
                  expectedSessionId: sessionId,
                  activeSessionEntry: currentEntry,
                  assertCommitAllowed: assertSettlementCurrent,
                });
              }
              throw error;
            }
            return settleResult({ result, expectedSession: currentEntry, sessionStore });
          },
        );
      },
    });
    const failed =
      entry.terminal.outcome.status === "error" || entry.terminal.outcome.status === "timeout";
    terminal.emit(
      failed ? "error" : "end",
      failed
        ? new Error(
            entry.terminal.outcome.error ??
              entry.result.meta.error?.message ??
              "All model fallback candidates failed",
          )
        : entry.result,
      entry.terminal.metadata,
    );
    return entry.result;
  } catch (error) {
    terminal.emit("error", error);
    throw error;
  } finally {
    await deferredLifecycle.complete();
  }
}
