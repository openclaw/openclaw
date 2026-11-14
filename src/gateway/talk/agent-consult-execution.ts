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
import { isClaudeCliProvider } from "../../agents/cli-output-records.js";
import { buildCliMcpDelegationCapabilityBinding } from "../../agents/cli-runner/mcp-grant-context.js";
import {
  buildCliSessionForkRunParams,
  clearCliSessionInStore,
} from "../../agents/cli-session-store.js";
import {
  getCliSessionBinding,
  shouldClearFailedCliSessionBinding,
} from "../../agents/cli-session.js";
import {
  isFallbackAttempt,
  prepareDelegationCapability,
} from "../../agents/delegation-capability.js";
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
import { resolveCyberAccessProgramForProvider } from "../../agents/model-catalog-access-programs.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { resolveAgentRunErrorLifecycleFields } from "../../agents/run-termination.js";
import {
  resolveCompatibleAgentRuntimeForProvider,
  resolveSessionRuntimeOverrideForProvider,
} from "../../agents/session-runtime-compat.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { createAgentLifecycleTerminalBackstop } from "../../auto-reply/reply/agent-lifecycle-terminal.js";
import { runCliAgentWithLifecycle } from "../../auto-reply/reply/agent-runner-cli-dispatch.js";
import { resolveCollapsedSessionAuthPinSource } from "../../config/sessions/auth-profile-override-provenance.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildGenericCliContextEngineHostSupport } from "../../context-engine/host-compat.js";
import { captureAgentRunLifecycleGeneration, emitAgentEvent } from "../../infra/agent-events.js";
import { clearAgentRunTerminalWriteContext } from "../../infra/agent-run-terminal-writes.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../plugins/hook-agent-context.js";
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

/** Talk owns one admitted turn; candidates reuse its transcript and terminal custody. */
export async function runTalkAgentTurn(params: TalkAgentTurnParams) {
  const { agentId, sessionId, sessionKey, storePath } = params.sessionTarget;
  const identity = { agentId, sessionId, sessionKey, runId: params.runId, lane: params.lane };
  let lifecycleGeneration =
    params.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(params.runId);
  const lifecycle = createDeferredEmbeddedRunLifecycleManager({
    ...identity,
    sessionFile: sessionKey,
    abortSignal: params.abortSignal,
  });
  const assertCurrent = () => {
    lifecycle.signal.throwIfAborted();
    params.preparedRunAdmission.assertSourceCurrent();
  };
  const terminal = createAgentLifecycleTerminalBackstop({
    runId: params.runId,
    sessionKey,
    getLifecycleGeneration: () => lifecycleGeneration,
    resolveTerminationFields: (error) =>
      resolveAgentRunErrorLifecycleFields(error, lifecycle.signal),
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
    const selectedAuth = {
      authProfileId: params.authProfileId ?? sessionEntry?.authProfileOverride,
      authProfileIdSource: params.authProfileId
        ? params.authProfileIdSource
        : resolveCollapsedSessionAuthPinSource(sessionEntry),
    };
    const sessionPinned =
      selectedAuth.authProfileId?.trim() === sessionEntry?.authProfileOverride?.trim() &&
      resolveCollapsedSessionAuthPinSource(sessionEntry) === "user";
    const authScope = (provider: string) =>
      resolveProviderIdForAuth(provider, {
        config: params.config,
        workspaceDir: params.workspaceDir,
      });
    const primaryAuthScope = authScope(selection.provider);
    const runtimeOverride = (provider: string) =>
      resolveCompatibleAgentRuntimeForProvider({
        provider,
        runtime: params.agentHarnessRuntimeOverride,
        cfg: params.config,
      }) ??
      resolveSessionRuntimeOverrideForProvider({
        provider,
        entry: sessionEntry,
        cfg: params.config,
      });
    const resolveRuntime = (provider: string, model: string, override?: string) =>
      resolveRunEntryCliRuntime({
        config: params.config,
        provider,
        model,
        agentId,
        authProfileId:
          sessionPinned || authScope(provider) === primaryAuthScope
            ? selectedAuth.authProfileId
            : undefined,
        sessionRuntimeOverride: override,
        pinnedHarnessId: resolveSessionPinnedHarnessId(sessionEntry),
      });
    const mediaTaskIds = getGeneratedMediaTaskIdsForSessionKey(sessionKey, agentId);
    const hasCommittedSideEffect = () =>
      hasNewGeneratedMediaTaskForSessionKey(sessionKey, mediaTaskIds, agentId);
    const entry = await runEmbeddedAgentEntry({
      preparedRunAdmission: params.preparedRunAdmission,
      modelResolve: {
        prompt: params.prompt,
        images: params.images,
        cwd: params.cwd,
        awaitSessionDiffBaseline: params.awaitSessionDiffBaseline,
        context: {
          ...buildAgentHookContextChannelFields(params),
          ...buildAgentHookContextIdentityFields(params),
          trigger: params.trigger,
        },
      },
      selection: {
        cfg: params.config,
        provider: selection.provider,
        model: selection.modelId,
        requestedRouteResolution: params.requestedRouteResolution,
        agentDir: params.agentDir,
        fallbacksOverride:
          params.modelFallbacksOverride ??
          resolveRunModelFallbacksOverride({ cfg: params.config, agentId, sessionKey }),
        userLockedAuthProfileId:
          selectedAuth.authProfileIdSource === "user" ? selectedAuth.authProfileId : undefined,
        cyberAccessProgram: params.cyberAccessProgram ?? sessionEntry?.cyberAccessProgram,
      },
      identity: {
        ...identity,
        sessionLifecycleRevision: sessionEntry?.lifecycleRevision ?? null,
      },
      harness: {
        workspaceDir: params.workspaceDir,
        sessionKey,
        preparation: { kind: "direct" },
        resolveRuntimeOverride: runtimeOverride,
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
      behavior: { kind: "command-rpc", hasCommittedSideEffect },
      sessionOverride: { kind: "preserve" },
      abortSignal: lifecycle.signal,
      onFallbackStep: (step) =>
        emitAgentEvent({
          ...identity,
          lifecycleGeneration,
          stream: "lifecycle",
          data: { phase: "fallback_step", ...step },
        }),
      runCandidate: async (requestedProvider, requestedModel, options) => {
        // The entry owner may retain the original candidate while a hook reroutes it.
        const provider = options.resolvedModelSelection?.provider ?? requestedProvider;
        const model = options.resolvedModelSelection?.modelId ?? requestedModel;
        assertCurrent();
        clearAgentRunTerminalWriteContext(params.preparedRunAdmission.operationalRunInstance);
        // A session pin follows the conversation and must fail closed on incompatibility;
        // an automatically selected account stays with its provider's auth scope.
        const candidateAuth = options.authProfileId
          ? { authProfileId: options.authProfileId, authProfileIdSource: "user" as const }
          : sessionPinned || authScope(provider) === primaryAuthScope
            ? selectedAuth
            : { authProfileId: undefined, authProfileIdSource: undefined };
        const candidateRuntimeOverride =
          resolveCompatibleAgentRuntimeForProvider({
            provider,
            runtime: options.agentHarnessRuntimeOverride,
            cfg: params.config,
          }) ?? runtimeOverride(provider);
        const runtime = resolveRuntime(provider, model, candidateRuntimeOverride);
        const common = {
          ...params,
          ...identity,
          ...options,
          ...candidateAuth,
          provider,
          model,
          agentHarnessRuntimeOverride: candidateRuntimeOverride,
          cyberAccessProgram:
            options.cyberAccessProgram ??
            params.cyberAccessProgram ??
            sessionEntry?.cyberAccessProgram,
          requestedRouteResolution: "resolved" as const,
          sessionFile: sessionKey,
          lifecycleGeneration,
          abortSignal: lifecycle.signal,
          suppressNextUserMessagePersistence:
            params.suppressNextUserMessagePersistence === true ||
            params.userTurnTranscriptRecorder?.hasPersisted() === true ||
            params.userTurnTranscriptRecorder?.isBlocked() === true,
        };
        if (!runtime.useCliExecution) {
          return runEmbeddedAgent({
            ...common,
            onExecutionStarted: (info) => {
              lifecycleGeneration = info?.lifecycleGeneration ?? lifecycleGeneration;
              return params.onExecutionStarted?.(info);
            },
            deferTerminalLifecycle: true,
            onDeferredLifecycleOwner: lifecycle.adopt,
            onDeferredLifecycleAbort: lifecycle.abort,
            onRetryWait: lifecycle.beginRetryWait,
          });
        }
        return withAdmittedCliCandidate(
          {
            claim: identity,
            admission: {
              preparedRunAdmission: params.preparedRunAdmission,
              lifecycleGeneration,
              isFinalFallbackAttempt: options.isFinalFallbackAttempt,
              abortSignal: lifecycle.signal,
              trigger: params.trigger,
              inputProvenance: params.inputProvenance,
            },
            provider: runtime.cliExecutionProvider,
            sessionTarget: params.sessionTarget,
            expectedLifecycleRevision: sessionEntry?.lifecycleRevision,
            readMode: "read-only",
            getSessionEntry: () => sessionEntry,
            classifyResult: options.classifyResult,
            onCompactionAccounting: params.onCompactionAccounting,
          },
          async ({
            sessionEntry: admittedEntry,
            cliSessionBinding,
            assertSettlementCurrent,
            settleResult,
            persistStoppedFirstSession,
          }) => {
            const accessProgram = resolveCyberAccessProgramForProvider(
              common.cyberAccessProgram,
              provider,
            ).program;
            if (accessProgram !== undefined && accessProgram !== "standard") {
              throw new Error(
                "Daybreak access is unsupported by this CLI runtime. Select Standard or use the OpenClaw or native Codex runtime.",
              );
            }
            const authProfileId = cliBackendAcceptsAuthProfileForwarding({
              provider: runtime.cliExecutionProvider,
              config: params.config,
              agentId,
            })
              ? await resolveCliExecutionAuthProfileId({
                  cliExecutionProvider: runtime.cliExecutionProvider,
                  authProfileProvider: provider,
                  config: params.config,
                  agentDir: params.agentDir ?? resolveAgentDir(params.config, agentId),
                  selected: candidateAuth,
                  sessionBinding: cliSessionBinding,
                })
              : candidateAuth.authProfileId;
            assertSettlementCurrent();
            const delegation = await prepareDelegationCapability({
              fallbackActive: isFallbackAttempt(options),
              run: common,
              sessionKey,
              sessionId,
              modelProvider: provider,
              modelId: model,
            });
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
                      abortSignal: lifecycle.signal,
                    },
                    (updated) => {
                      currentEntry = updated;
                    },
                  )
                : {};
            const admittedRunContext = await resolvePreparedRunAdmission({
              runId: params.runId,
              runtimeKind: "embedded",
              preparedRunAdmission: params.preparedRunAdmission,
            });
            assertSettlementCurrent();
            try {
              const result = await withGatewayToolCallerIdentity(
                createAdmittedGatewayToolCallerIdentity({
                  agentId,
                  sessionKey,
                  admittedRunContext,
                }),
                () =>
                  runCliAgentWithLifecycle({
                    runId: params.runId,
                    lifecycleGeneration,
                    runParams: {
                      ...common,
                      ...fork,
                      ...buildCliMcpDelegationCapabilityBinding(delegation),
                      onExecutionStarted: () =>
                        params.onExecutionStarted?.({ lifecycleGeneration }),
                      diagnosticOwner: lifecycle.handoffToCli(),
                      assertCurrent: assertSettlementCurrent,
                      runtimePolicySessionKey: params.sandboxSessionKey,
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
                      persistStoppedFirstCliSession: (binding) =>
                        persistStoppedFirstSession({
                          binding,
                          expectedSession: currentEntry,
                          sessionStore,
                        }),
                    },
                  }),
              );
              return settleResult({ result, expectedSession: currentEntry, sessionStore });
            } catch (error) {
              const binding = getCliSessionBinding(currentEntry, runtime.cliExecutionProvider);
              if (
                isClaudeCliProvider(runtime.cliExecutionProvider) &&
                sessionStore &&
                binding?.sessionId &&
                shouldClearFailedCliSessionBinding({
                  error,
                  binding,
                  bindingReplacedDuringRun: binding.sessionId !== cliSessionBinding?.sessionId,
                  hasNewGeneratedMediaTask: hasCommittedSideEffect(),
                })
              ) {
                await clearCliSessionInStore({
                  agentId,
                  provider: runtime.cliExecutionProvider,
                  sessionKey,
                  storePath,
                  sessionStore,
                  expectedCliSessionId: binding.sessionId,
                  expectedSessionId: sessionId,
                  activeSessionEntry: currentEntry,
                  assertCommitAllowed: assertSettlementCurrent,
                });
              }
              throw error;
            }
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
    await lifecycle.complete();
  }
}
