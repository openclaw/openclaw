import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope.js";
import type { LiveSessionModelSelection } from "../../agents/live-model-switch.js";
import { findModelInCatalog } from "../../agents/model-catalog-lookup.js";
import { scopePreparedModelRuntimeLease } from "../../agents/prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  type PreparedModelRuntimeLease,
} from "../../agents/prepared-model-runtime.js";
import { resolveSessionStableReplyMode } from "../../auto-reply/reply/session-stable-reply-mode.js";
import { selectLiveRuntimeConfig } from "../../config/runtime-snapshot.js";
import { resolveSessionModelOverrideSource } from "../../config/sessions/model-override-provenance.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveCreatorSandbox } from "../../gateway/operator-role-policy.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
} from "../../sessions/agent-harness-session-key.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { settleCurrentReadPreparations } from "../../shared/current-read-authority.js";
import { resolveCronSkillsSnapshot } from "../../skills/runtime/cron-snapshot.js";
import {
  waitForAgentDatabaseWriteAdmission,
  waitForAgentInputAdmission,
} from "../../state/agent-database-preparation-context.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { cronExecutionActor } from "../human-owner.js";
import {
  resolveCronCandidateInferenceBinding,
  resolveCronRuntimeSessionEntry,
} from "../inference-binding.js";
import { CronSessionLifecycleClaimError } from "../run-authority.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import type { CronWorkspaceLease } from "../run-workspace.js";
import { resolveCronScheduledToolPolicy } from "../scheduled-tool-policy.js";
import { resolveCronRunToolsAllow } from "../tools-allow.js";
import {
  resolveCronModelSelection,
  resolveCronModelSelectionOwner,
  resolveCronThinkingSelection,
} from "./model-selection.js";
import { prepareCronAutomationPrompt } from "./run-automation-context.js";
import { resolveCronCommandPromptPreflight } from "./run-command-preflight.js";
import { resolveCronAgentConfig } from "./run-config.js";
import {
  createCronToolsAllowPreflightDiagnostics,
  resolveCronDeliveryContext,
} from "./run-delivery-trace.js";
import { resolveCronPreflight } from "./run-fallback-policy.js";
import {
  resolveCronAuthSelection,
  createCronSessionRowWriter,
  retireRolledCronSessionMcpRuntime,
  type RunCronAgentTurnParams,
  type WithRunSession,
} from "./run-prepare-runtime.js";
import {
  beginCronPreparationEffect,
  createCronRunContinuationSession,
  createPersistCronSessionEntry,
  setCronSessionRuntimeModel,
  setCronSessionAgentHarnessId,
  type MutableCronSession,
} from "./run-session-state.js";
import { resolveCronRunTimeoutOverrideMs } from "./run-timeout.js";
import { prepareCronSessionWorkspace } from "./run-workspace.js";
import {
  logWarn,
  normalizeAgentId,
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentTimeoutMs,
  resolveAgentWorkspaceDir,
  resolveEffectiveAgentRuntime,
  resolveCronStyleNow,
  resolveHookExternalContentSource,
  resolveSessionRuntimeOverrideForProvider,
  resolveThinkingSelection,
} from "./run.runtime.js";
import { resolveCronRunSessionKeys } from "./session-key.js";
import { prepareCronSession } from "./session.js";

export type CronRunPreparationParams = {
  input: RunCronAgentTurnParams;
  isFastTestEnv: boolean;
  onLifecycleInterrupt: () => void;
};

export async function resolveCronRunPreparation(params: CronRunPreparationParams) {
  let { input } = params;
  input.assertCurrent?.();
  // Admission freezes authored policy and grants; credential revocation remains live.
  input = {
    ...input,
    job: {
      ...input.job,
      payload: structuredClone(input.job.payload),
      inferenceBinding: input.job.inferenceBinding && { ...input.job.inferenceBinding },
      inferenceGrants: input.job.inferenceGrants && structuredClone(input.job.inferenceGrants),
    },
  };
  const commandPromptPreflight = resolveCronCommandPromptPreflight(input.job);
  if (commandPromptPreflight) {
    return { ok: false as const, result: commandPromptPreflight };
  }
  const requestedRuntimeCfg = selectLiveRuntimeConfig(input.cfg);
  const requestedAgentId = input.agentId?.trim() || input.job.agentId?.trim();
  const normalizedRequested = requestedAgentId ? normalizeAgentId(requestedAgentId) : undefined;
  const requiredAgentId =
    normalizedRequested ?? parseAgentSessionKey(input.job.sessionKey ?? input.sessionKey)?.agentId;
  const initialAgentId = resolveCronJobEffectiveAgentId(
    { agentId: requiredAgentId },
    tryResolveAmbientOwnerAgentId(requestedRuntimeCfg),
  );
  await waitForAgentDatabaseWriteAdmission(initialAgentId, {
    signal: input.abortSignal ?? input.signal,
  });
  await using runtimeResources = new AsyncDisposableStack();
  let runtimeLease: ReturnType<typeof scopePreparedModelRuntimeLease> | undefined;
  const publishedRuntime = await loadPublishedGatewayReplyDispatchRuntime({
    agentId: initialAgentId,
    demand: "scheduled",
    abortSignal: input.abortSignal ?? input.signal,
    onRuntimeLease: (lease) => {
      runtimeLease = runtimeResources.use(scopePreparedModelRuntimeLease(lease));
    },
  });
  const modelOwner = await resolveCronModelSelectionOwner({
    cfg: requestedRuntimeCfg,
    publishedRuntime,
    ...(requiredAgentId
      ? {
          agentId: initialAgentId,
          requiredAgentId,
          agentDir: resolveAgentDir(requestedRuntimeCfg, initialAgentId),
          workspaceDir: resolveAgentWorkspaceDir(requestedRuntimeCfg, initialAgentId),
        }
      : {}),
  });
  const { agentId, agentDir } = modelOwner;
  const agentConfigOverride = requiredAgentId
    ? resolveAgentConfig(modelOwner.config, agentId)
    : undefined;
  const { runtimeConfig: runtimeCfg, agentDefaults: agentCfg } = resolveCronAgentConfig({
    config: modelOwner.config,
    agentConfigOverride,
  });
  const { baseSessionKey, usesDetachedRunSession, agentSessionKey, sourceSessionKey } =
    resolveCronRunSessionKeys({
      job: input.job,
      sessionKey: input.sessionKey,
      agentId,
      cfg: runtimeCfg,
    });
  await waitForAgentInputAdmission(agentId, {
    cfg: runtimeCfg,
    sessionKey: agentSessionKey,
    signal: input.abortSignal ?? input.signal,
  });
  const payloadHookExternalContentSource =
    input.job.payload.kind === "agentTurn" ? input.job.payload.externalContentSource : undefined;
  const hookExternalContentSource =
    payloadHookExternalContentSource ?? resolveHookExternalContentSource(baseSessionKey);

  const isGmailHook = hookExternalContentSource === "gmail";
  return {
    ok: true as const,
    resources: runtimeResources.move(),
    runtimeLease,
    admission: {
      agentId,
      storePath: resolveSessionStorePathCore(runtimeCfg.session?.store, { agentId }),
      sessionKey: agentSessionKey,
      signal: input.abortSignal ?? input.signal,
      onInterrupt: params.onLifecycleInterrupt,
      onLaneWait: input.onLaneWait,
    },
    prepare: async (signal: AbortSignal) => {
      input = { ...input, abortSignal: signal };
      return await prepareAdmittedSession();
    },
  };

  async function prepareAdmittedSession() {
    const now = Date.now();
    // A child run never runs looser than its parent.
    const sandbox =
      resolveCreatorSandbox(runtimeCfg, { actor: cronExecutionActor(input.job) }) ??
      input.occurrence.childParent?.sandbox;
    const usesExactRunSession = usesDetachedRunSession || baseSessionKey.startsWith("cron:");
    const cronSession: MutableCronSession = await prepareCronSession({
      cfg: runtimeCfg,
      sessionKey: agentSessionKey,
      sourceSessionKey,
      skillLibrarySelections: input.job.skillLibrarySelections,
      agentId,
      nowMs: now,
      forceNew: usesDetachedRunSession,
      exactRunSession: usesExactRunSession,
      hookExternalContentSource,
      inferenceCaptured: Boolean(input.job.inferenceBinding?.runtime),
    });
    const sourceEntry = sourceSessionKey ? cronSession.store[sourceSessionKey] : undefined;
    const completionSource = input.job.sourceConversation ?? sourceEntry;
    const sourceSessionGeneration = completionSource
      ? {
          sessionId: completionSource.sessionId,
          lifecycleRevision: completionSource.lifecycleRevision,
        }
      : undefined;
    const reservedKey = isAgentHarnessSessionKey(agentSessionKey);
    if (cronSession.initialSessionEntry?.modelSelectionLocked === true) {
      throw new Error(
        reservedKey
          ? AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE
          : AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
      );
    }
    if (reservedKey && !cronSession.initialSessionEntry) {
      throw new Error(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);
    }
    const runSessionId = cronSession.sessionEntry.sessionId;
    const currentRunSessionId = () => cronSession.sessionEntry.sessionId ?? runSessionId;
    const runSessionKey = usesExactRunSession
      ? `${agentSessionKey}:run:${runSessionId}`
      : agentSessionKey;
    const sessionPreparationEffect = await beginCronPreparationEffect({
      agentId,
      cronSession,
      agentSessionKey,
      runSessionKey,
      usesDetachedRunSession,
      signal: input.abortSignal ?? input.signal,
      onInterrupt: params.onLifecycleInterrupt,
    });

    let preparedModelRuntimeLease: PreparedModelRuntimeLease | undefined;
    let workspaceLease: CronWorkspaceLease | undefined;
    let workspaceLeaseTransferred = false;
    try {
      const selectedWorkspace = await prepareCronSessionWorkspace({
        cfg: runtimeCfg,
        agentId,
        input,
        agentCfg,
        sessionKey: agentSessionKey,
        cronSession,
        defaultWorkspaceDir: modelOwner.workspaceDir,
        sessionPreparationEffect,
        isFastTestEnv: params.isFastTestEnv,
        childParent: input.occurrence.childParent,
      });
      workspaceLease = selectedWorkspace.lease;
      const workspaceDir = selectedWorkspace.workspaceDir;
      const persistCronSessionRow = createCronSessionRowWriter({
        agentId,
        agentSessionKey,
        assertCurrent: input.assertCurrent,
      });
      const persistSessionEntry = createPersistCronSessionEntry({
        cronSession,
        agentSessionKey,
        createdActor: cronExecutionActor(input.job),
        sandbox,
        workspaceDir,
        persistSessionEntry: persistCronSessionRow,
      });
      const withRunSession: WithRunSession = (result) => ({
        ...result,
        sessionId: currentRunSessionId(),
        sessionKey: runSessionKey,
      });
      if (!cronSession.sessionEntry.label?.trim() && baseSessionKey.startsWith("cron:")) {
        const labelSuffix =
          typeof input.job.name === "string" && input.job.name.trim()
            ? input.job.name.trim()
            : input.job.id;
        cronSession.sessionEntry.label = `Automation: ${labelSuffix}`;
      }

      const resolvedModelSelection = await resolveCronModelSelection({
        cfg: runtimeCfg,
        owner: modelOwner,
        agentConfigOverride,
        sessionEntry: cronSession.sessionEntry,
        payloadModel: input.job.payload.kind === "agentTurn" ? input.job.payload.model : undefined,
        isGmailHook,
        agentId,
        agentDir,
        workspaceDir,
      });
      if (!resolvedModelSelection.ok) {
        return {
          ok: false as const,
          result: withRunSession({
            status: "error",
            error: resolvedModelSelection.error,
            diagnostics: createCronRunDiagnosticsFromError(
              "cron-preflight",
              resolvedModelSelection.error,
            ),
          }),
        };
      }
      const cfgWithAgentDefaults = resolvedModelSelection.cfgWithAgentDefaults;
      const { useSubagentFallbacks, inheritDefaultFallbacksForAgentStringModel } =
        resolvedModelSelection;
      const sessionModelOverrideSource =
        resolvedModelSelection.modelSource === "session"
          ? (resolveSessionModelOverrideSource(cronSession.sessionEntry) ?? undefined)
          : undefined;

      const inferencePrimary = {
        provider: resolvedModelSelection.provider,
        model: resolvedModelSelection.model,
      };
      const bindingFor = (provider: string, model: string) =>
        resolveCronCandidateInferenceBinding(
          {
            binding: input.job.inferenceBinding,
            grants: input.job.inferenceGrants,
            primary: inferencePrimary,
          },
          provider,
          model,
        );
      const preflight = await resolveCronPreflight({
        cfg: cfgWithAgentDefaults,
        job: input.job,
        agentId: modelOwner.agentId,
        provider: resolvedModelSelection.provider,
        model: resolvedModelSelection.model,
        useSubagentFallbacks,
        inheritDefaultFallbacksForAgentStringModel,
        sessionModelOverrideSource,
      });
      if (!preflight.ok) {
        logWarn(`[cron:${input.job.id}] ${preflight.reason}`);
        return {
          ok: false as const,
          result: withRunSession({
            status: "skipped",
            error: preflight.reason,
            diagnostics: createCronRunDiagnosticsFromError("model-preflight", preflight.reason, {
              severity: "warn",
            }),
            provider: resolvedModelSelection.provider,
            model: resolvedModelSelection.model,
          }),
        };
      }
      const { provider, model, modelFallbacksOverride, runtimePluginCandidates } = preflight;
      // A captured runtime replaces the override the cron session copied from its source row.
      const runtimeSessionEntry = resolveCronRuntimeSessionEntry(
        bindingFor(provider, model),
        cronSession.sessionEntry,
      );
      const effectiveAgentRuntime = resolveEffectiveAgentRuntime({
        cfg: cfgWithAgentDefaults,
        provider,
        modelId: model,
        agentId: modelOwner.agentId,
        sessionKey: agentSessionKey,
        sessionEntry: runtimeSessionEntry,
      });
      const thinkingSelection = await resolveCronThinkingSelection({
        cfg: cfgWithAgentDefaults,
        owner: modelOwner,
        provider,
        model,
        agentRuntime: effectiveAgentRuntime,
        jobThinking:
          input.job.payload.kind === "agentTurn" ? input.job.payload.thinking : undefined,
        hookThinking: isGmailHook ? runtimeCfg.hooks?.gmail?.thinking : undefined,
        sessionThinking: cronSession.sessionEntry.thinkingLevel,
      });
      const {
        requestedLevel: requestedThinkLevel,
        level: fallbackThinkLevel,
        supported: thinkingLevelSupported,
      } = resolveThinkingSelection({
        cfg: cfgWithAgentDefaults,
        agentId: modelOwner.agentId,
        provider,
        model,
        level: thinkingSelection.requestedThinkLevel,
        catalog: thinkingSelection.catalog,
        agentRuntime: effectiveAgentRuntime,
      });
      if (!thinkingLevelSupported && fallbackThinkLevel !== requestedThinkLevel) {
        logWarn(
          `[cron:${input.job.id}] Thinking level "${requestedThinkLevel}" is not supported for ${provider}/${model}; using "${fallbackThinkLevel}" for this candidate.`,
        );
      }

      preparedModelRuntimeLease = await acquireAgentRunPreparedModelRuntime(
        {
          // Admit the selected runtime before auth/session preparation can publish a replacement.
          // Every later side effect and embedded execution retains this exact derived generation.
          config: modelOwner.config,
          agentId,
          agentDir,
          workspaceDir,
          allowGatewaySubagentBinding: true,
          runtimePluginSelections: runtimePluginCandidates.map((candidate) => {
            const runtime = resolveSessionRuntimeOverrideForProvider({
              provider: candidate.provider,
              entry: resolveCronRuntimeSessionEntry(
                bindingFor(candidate.provider, candidate.model),
                cronSession.sessionEntry,
              ),
              cfg: cfgWithAgentDefaults,
            });
            return runtime
              ? { provider: candidate.provider, modelId: candidate.model, runtime, agentId }
              : { provider: candidate.provider, modelId: candidate.model, agentId };
          }),
        },
        {
          catalogMode: "static",
          ...(publishedRuntime
            ? { pluginGeneration: publishedRuntime.pluginGeneration }
            : { pluginMetadataSnapshot: modelOwner.metadataSnapshot }),
          abortSignal: input.abortSignal ?? input.signal,
        },
      );
      const admittedRuntimeLease = preparedModelRuntimeLease;
      return await admittedRuntimeLease.run(async () => {
        const admittedConfig = admittedRuntimeLease.snapshot.config;

        const explicitTimeoutSeconds =
          input.job.payload.kind === "agentTurn" ? input.job.payload.timeoutSeconds : undefined;
        const timeoutMs = resolveAgentTimeoutMs({
          cfg: cfgWithAgentDefaults,
          overrideSeconds: explicitTimeoutSeconds,
        });
        // Preserve an explicit cron timeout even when it equals the agent default;
        // the embedded runner uses its presence to configure the idle watchdog.
        const runTimeoutOverrideMs = resolveCronRunTimeoutOverrideMs(explicitTimeoutSeconds);
        const agentPayload =
          input.job.payload.kind === "agentTurn"
            ? { ...input.job.payload, toolsAllow: resolveCronRunToolsAllow(input.job) }
            : null;
        const configuredProvider = admittedConfig.models?.providers?.[provider];
        const catalogModel = findModelInCatalog(thinkingSelection.catalog, provider, model);
        const configuredModel = configuredProvider?.models?.find(
          (candidate) => candidate.id === model,
        );
        const modelApi = catalogModel?.api ?? configuredModel?.api ?? configuredProvider?.api;
        // Drain both readers before failure cleanup releases the admitted runtime.
        const [
          preflightDiagnostics,
          {
            deliveryPlan,
            deliveryRequested,
            resolvedDelivery,
            sourceDelivery,
            deliverySystemPrompt,
            messageToolFormatPrompt,
          },
        ] = await settleCurrentReadPreparations([
          createCronToolsAllowPreflightDiagnostics({
            cfg: admittedConfig,
            jobId: input.job.id,
            provider,
            model,
            modelApi,
            modelBaseUrl:
              catalogModel?.baseUrl ?? configuredModel?.baseUrl ?? configuredProvider?.baseUrl,
            modelParams: catalogModel?.params ?? configuredModel?.params,
            agentId: modelOwner.agentId,
            agentDir: modelOwner.agentDir,

            sessionKey: agentSessionKey,
            agentPayload,
          }),
          resolveCronDeliveryContext({
            cfg: admittedConfig,
            job: input.job,
            agentId,
          }),
        ] as const);
        // Persistent wakes share chat's binding policy; announce targeting is turn-local.
        const cliSessionBindingFacts = {
          extraSystemPromptStatic: deliverySystemPrompt,
          sourceReplyDeliveryMode: usesExactRunSession
            ? sourceDelivery.sourceReplyDeliveryMode
            : await resolveSessionStableReplyMode({
                cfg: admittedConfig,
                metadataSnapshot: admittedRuntimeLease.snapshot.metadataSnapshot,
                ctx: { CommandAuthorized: false },
                sessionEntry: cronSession.sessionEntry,
                sessionAgentId: agentId,
                sessionKey: runSessionKey,
              }),
          requireExplicitMessageTarget: usesExactRunSession
            ? sourceDelivery.messageTool.requireExplicitTarget
            : undefined,
        };

        const { formattedTime, timeLine } = resolveCronStyleNow(runtimeCfg, now);
        const assertPreparationCurrent = () => {
          input.assertCurrent?.();
          (input.abortSignal ?? input.signal)?.throwIfAborted();
          if (!sessionPreparationEffect.isActive()) {
            throw new CronSessionLifecycleClaimError(agentSessionKey);
          }
        };
        const { sourcePromptPrefix, isExternalHook, commandBody } =
          await prepareCronAutomationPrompt({
            cfg: admittedConfig,
            job: input.job,
            agentId,
            runSessionKey,
            message: input.message,
            sourceSessionKey,
            sourceEntry,
            storePath: cronSession.storePath,
            cronStorePath: input.cronStorePath,
            assertCurrent: assertPreparationCurrent,
            signal: input.abortSignal ?? input.signal,
            baseSessionKey,
            hookExternalContentSource,
            formattedTime,
            timeLine,
          });

        const skillsSnapshot = await resolveCronSkillsSnapshot({
          workspaceDir,
          config: admittedConfig,
          agentId,
          existingSnapshot: cronSession.sessionEntry.skillsSnapshot,
          librarySelections: cronSession.sessionEntry.skillLibrarySelections,
          isFastTestEnv: params.isFastTestEnv,
        });
        if (!params.isFastTestEnv && skillsSnapshot !== cronSession.sessionEntry.skillsSnapshot) {
          cronSession.sessionEntry = {
            ...cronSession.sessionEntry,
            skillsSnapshot,
          };
        }

        setCronSessionRuntimeModel({ entry: cronSession.sessionEntry, provider, model });
        setCronSessionAgentHarnessId({
          entry: cronSession.sessionEntry,
          agentHarnessId: effectiveAgentRuntime,
        });
        cronSession.sessionEntry.systemSent = true;
        let preRunSessionPersisted = false;
        try {
          await persistSessionEntry();
          preRunSessionPersisted = true;
        } catch (err) {
          if (err instanceof CronSessionLifecycleClaimError) {
            throw err;
          }
          logWarn(`[cron:${input.job.id}] Failed to persist pre-run session entry: ${String(err)}`);
          if (sandbox === "required" || cronSession.sessionEntry.sandbox === "required") {
            throw err;
          }
        }
        await retireRolledCronSessionMcpRuntime({
          job: input.job,
          cronSession,
        });
        const candidateBinding = bindingFor(provider, model);
        const authSelection = input.job.runtimeAuthority
          ? undefined
          : candidateBinding
            ? {
                profileId: candidateBinding.profileId,
                source: candidateBinding.source,
              }
            : await resolveCronAuthSelection({
                agentId,
                cfg: admittedConfig,
                provider,
                modelId: model,
                agentRuntime: effectiveAgentRuntime,
                ...(provider === resolvedModelSelection.provider &&
                resolvedModelSelection.configuredProfileId
                  ? { configuredProfileId: resolvedModelSelection.configuredProfileId }
                  : {}),
                agentDir,
                cronSession,
                sessionKey: agentSessionKey,
                isNewSession: cronSession.isNewSession && input.job.sessionTarget !== "isolated",
              });
        const authProfileId = authSelection?.profileId;
        const liveSelection: LiveSessionModelSelection = {
          provider,
          model,
          agentRuntimeOverride: resolveSessionRuntimeOverrideForProvider({
            provider,
            entry: runtimeSessionEntry,
            cfg: admittedConfig,
          }),
          authProfileId,
          authProfileIdSource: authSelection?.source,
        };
        const runContinuationSession = usesExactRunSession
          ? createCronRunContinuationSession({
              cronSession,
              runSessionKey,
              createdActor: cronExecutionActor(input.job),
              sandbox,
              thinkingLevel: requestedThinkLevel,
              toolsAllow: agentPayload?.toolsAllow,
              toolsAllowIsDefault: agentPayload?.toolsAllowIsDefault,
              scheduledToolPolicy: resolveCronScheduledToolPolicy({
                toolsAllow: agentPayload?.toolsAllow,
                scheduledToolPolicy: input.job.scheduledToolPolicy,
                owner: input.job.owner,
              }),
              scheduledToolCallerOrigin: input.job.toolsAllowProvenance?.callerOrigin,
              toolsAllowExecTarget: input.job.toolsAllowExecTarget,
              toolsAllowExecTargetRequirement: input.job.toolsAllowExecTargetRequirement,
              cliSessionBindingFacts,
            })
          : undefined;
        await runContinuationSession?.initialize();

        workspaceLeaseTransferred = true;
        return {
          ok: true as const,
          context: {
            input,
            // Execution borrows the admitted owner's config; flattened defaults only select it.
            cfgWithAgentDefaults: admittedConfig,
            agentId,
            agentCfg,
            agentDir,
            agentSessionKey,
            sourceSessionKey: input.job.sourceConversation?.sessionKey ?? sourceSessionKey,
            sourceSessionGeneration,
            runSessionId,
            currentRunSessionId,
            runSessionKey,
            usesDetachedRunSession,
            workspaceDir,
            cwd: selectedWorkspace.cwd,
            workspaceLease,
            commandBody,
            inputProvenance:
              agentPayload && !isExternalHook
                ? ({
                    kind: "internal_system",
                    sourceTool: "cron",
                    sourcePromptPrefix,
                    jobId: input.job.id,
                    runId: runSessionId,
                    sourceSessionKey: runSessionKey,
                  } satisfies InputProvenance)
                : undefined,
            cronSession,
            sessionPreparationEffect,
            persistSessionEntry,
            preRunSessionPersisted,
            runContinuationSession,
            withRunSession,
            agentPayload,
            deliveryPlan,
            resolvedDelivery,
            deliveryRequested,
            // Trusted formatting metadata belongs to the resolved delivery channel.
            deliverySystemPrompt,
            // Applied only after the final tool surface exposes the message tool.
            messageToolFormatPrompt,
            sourceDelivery,
            cliSessionBindingFacts,
            suppressExecNotifyOnExit: deliveryPlan.mode === "none",
            skillsSnapshot,
            inferencePrimary,
            liveSelection,
            useSubagentFallbacks,
            inheritDefaultFallbacksForAgentStringModel,
            sessionModelOverrideSource,
            modelFallbacksOverride,
            thinkingSelection,
            timeoutMs,
            preflightDiagnostics,
            runTimeoutOverrideMs,
            preparedModelRuntimeLease: admittedRuntimeLease,
          },
        };
      });
    } catch (error) {
      await using _ = preparedModelRuntimeLease;
      throw error;
    } finally {
      if (!workspaceLeaseTransferred) {
        sessionPreparationEffect.release();
        await workspaceLease?.release();
      }
    }
  }
}
