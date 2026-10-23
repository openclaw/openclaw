/** Session identity and context preparation for isolated cron runs. */
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope.js";
import type { LiveSessionModelSelection } from "../../agents/live-model-switch.js";
import { findModelInCatalog } from "../../agents/model-catalog-lookup.js";
import { scopePreparedModelRuntimeLease } from "../../agents/prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  type PreparedModelRuntimeLease,
} from "../../agents/prepared-model-runtime.js";
import { captureSessionEventTargetForHost } from "../../auto-reply/reply/session-event-target.js";
import { resolveSessionStableReplyMode } from "../../auto-reply/reply/session-stable-reply-mode.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveCreatorSandbox } from "../../gateway/operator-role-policy.js";
import { isCronSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
} from "../../sessions/agent-harness-session-key.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { resolveCronSkillsSnapshot } from "../../skills/runtime/cron-snapshot.js";
import { waitForAgentDatabaseWriteAdmission } from "../../state/agent-database-preparation-context.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { CronSessionLifecycleClaimError } from "../run-authority.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import type { CronWorkspaceLease } from "../run-workspace.js";
import { resolveCronScheduledToolPolicy } from "../scheduled-tool-policy.js";
import { isDetachedCronSessionTarget, resolveCronDeliverySessionKey } from "../session-target.js";
import { resolveCronRunToolsAllow } from "../tools-allow.js";
import {
  resolveCronModelSelection,
  resolveCronModelSelectionOwner,
  resolveCronThinkingSelection,
} from "./model-selection.js";
import { prepareCronAutomationPrompt } from "./run-automation-context.js";
import { resolveCronCommandPromptPreflight } from "./run-command-preflight.js";
import { resolveCronActiveRuntimeConfig, resolveCronAgentConfig } from "./run-config.js";
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
  withCronSessionPreparation,
  createCronRunContinuationSession,
  createPersistCronSessionEntry,
  setCronSessionRuntimeModel,
  setCronSessionAgentHarnessId,
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
import { resolveCronAgentSessionKey } from "./session-key.js";
import { prepareCronSession } from "./session.js";

type CronRunPreparation = Extract<
  Awaited<ReturnType<typeof resolveCronRunPreparation>>,
  { ok: true }
>;

export type PreparedCronRunContext = Extract<
  Awaited<ReturnType<CronRunPreparation["prepare"]>>,
  { ok: true }
>["context"];

type CronRunPreparationParams = {
  input: RunCronAgentTurnParams;
  isFastTestEnv: boolean;
  onLifecycleInterrupt: () => void;
};

export async function prepareCronRunContext(
  params: CronRunPreparationParams & {
    runPrepared?: (
      context: PreparedCronRunContext,
    ) => Promise<import("./run.types.js").RunCronAgentTurnResult>;
  },
) {
  const resolved = await resolveCronRunPreparation(params);
  if (!resolved.ok) {
    return resolved;
  }
  await using _ = resolved.resources;
  const prepareSession = () =>
    withCronSessionPreparation(resolved.admission, async (signal) => {
      const prepared = await resolved.prepare(signal);
      const runPrepared = params.runPrepared;
      if (!prepared.ok) {
        return prepared;
      }
      if (!runPrepared) {
        return { ...prepared, completed: undefined };
      }
      // Execution retains its selected runtime; close preparation's borrowed dispatch scope.
      await resolved.resources.disposeAsync();
      // Materialize the prepared incarnation for inference and its own finalization effects.
      return await withSessionTurn(
        {
          sessionKey: prepared.context.runSessionKey,
          sessionId: prepared.context.runSessionId,
          agentId: resolved.admission.agentId,
          storePath: prepared.context.cronSession.storePath,
          abortSignal: signal,
        },
        async () => ({ ...prepared, completed: await runPrepared(prepared.context) }),
      );
    });
  return resolved.runtimeLease
    ? await resolved.runtimeLease.run(prepareSession)
    : await prepareSession();
}

async function resolveCronRunPreparation(params: CronRunPreparationParams) {
  let { input } = params;
  input.assertCurrent?.();
  const commandPromptPreflight = resolveCronCommandPromptPreflight(input.job);
  if (commandPromptPreflight) {
    return { ok: false as const, result: commandPromptPreflight };
  }
  const requestedRuntimeCfg = resolveCronActiveRuntimeConfig(input.cfg);
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
  const resultSessionKey =
    (input.job.sessionTarget === "isolated"
      ? input.job.sourceConversation?.sessionKey
      : undefined) ??
    resolveCronDeliverySessionKey(input.job) ??
    resolveAgentMainSessionKey({ cfg: requestedRuntimeCfg, agentId: initialAgentId });
  const resultTarget = await captureSessionEventTargetForHost(initialAgentId, resultSessionKey, {
    assertCaptureCurrent: input.assertCurrent,
  });
  input.assertCurrent?.();
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
  const baseSessionKey = (input.sessionKey?.trim() || `cron:${input.job.id}`).trim();
  const currentBoundSourceKey =
    input.job.sessionTarget === "current" ? input.job.sessionKey?.trim() : undefined;
  const usesDetachedRunSession =
    isDetachedCronSessionTarget(input.job.sessionTarget) || Boolean(currentBoundSourceKey);
  const baseSessionKeyIsCron =
    baseSessionKey.startsWith("cron:") || isCronSessionKey(baseSessionKey);
  const cronExecutionSessionKey =
    usesDetachedRunSession && !baseSessionKeyIsCron ? `cron:${input.job.id}` : baseSessionKey;
  const agentSessionKey = resolveCronAgentSessionKey({
    sessionKey: cronExecutionSessionKey,
    agentId,
    mainKey: runtimeCfg.session?.mainKey,
    cfg: runtimeCfg,
  });
  const resolvedBaseSessionKey = resolveCronAgentSessionKey({
    sessionKey: currentBoundSourceKey ?? baseSessionKey,
    agentId,
    mainKey: runtimeCfg.session?.mainKey,
    cfg: runtimeCfg,
  });
  const sourceSessionKey =
    currentBoundSourceKey && resolvedBaseSessionKey !== agentSessionKey
      ? resolvedBaseSessionKey
      : undefined;
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
    const sandbox = resolveCreatorSandbox(runtimeCfg, { actor: input.job.createdActor });
    const usesExactRunSession = usesDetachedRunSession || baseSessionKey.startsWith("cron:");
    const cronSession = await prepareCronSession({
      cfg: runtimeCfg,
      sessionKey: agentSessionKey,
      sourceSessionKey,
      skillLibrarySelections: input.job.skillLibrarySelections,
      agentId,
      nowMs: now,
      forceNew: usesDetachedRunSession,
      exactRunSession: usesExactRunSession,
      hookExternalContentSource,
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
      });
      workspaceLease = selectedWorkspace.lease;
      const workspaceDir = selectedWorkspace.workspaceDir;
      const persistCronSessionRow = createCronSessionRowWriter({
        agentId,
        agentSessionKey,
        assertCurrent: input.assertCurrent,
        resultTarget,
        cronSession,
      });
      const persistSessionEntry = createPersistCronSessionEntry({
        cronSession,
        agentSessionKey,
        createdActor: input.job.createdActor,
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

      const preflight = await resolveCronPreflight({
        cfg: cfgWithAgentDefaults,
        job: input.job,
        agentId: modelOwner.agentId,
        provider: resolvedModelSelection.provider,
        model: resolvedModelSelection.model,
        useSubagentFallbacks,
        inheritDefaultFallbacksForAgentStringModel,
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
      const effectiveAgentRuntime = resolveEffectiveAgentRuntime({
        cfg: cfgWithAgentDefaults,
        provider,
        modelId: model,
        agentId: modelOwner.agentId,
        sessionKey: agentSessionKey,
        sessionEntry: cronSession.sessionEntry,
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
              entry: cronSession.sessionEntry,
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
      const admittedConfig = preparedModelRuntimeLease.snapshot.config;

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
      const preflightDiagnostics = await createCronToolsAllowPreflightDiagnostics({
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
      });
      const {
        deliveryPlan,
        deliveryRequested,
        resolvedDelivery,
        sourceDelivery,
        deliverySystemPrompt,
        messageToolFormatPrompt,
      } = await resolveCronDeliveryContext({
        cfg: admittedConfig,
        job: input.job,
        agentId,
      });
      // Persistent wakes share chat's binding policy; announce targeting is turn-local.
      const cliSessionBindingFacts = {
        extraSystemPromptStatic: deliverySystemPrompt,
        sourceReplyDeliveryMode: usesExactRunSession
          ? sourceDelivery.sourceReplyDeliveryMode
          : await resolveSessionStableReplyMode({
              cfg: admittedConfig,
              metadataSnapshot: preparedModelRuntimeLease.snapshot.metadataSnapshot,
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
      const { sourcePromptPrefix, isExternalHook, commandBody } = await prepareCronAutomationPrompt(
        {
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
        },
      );

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
          updatedAt: Date.now(),
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
      const authSelection = input.job.runtimeAuthority
        ? undefined
        : input.job.inferenceBinding
          ? {
              profileId: input.job.inferenceBinding.profileId,
              source: input.job.inferenceBinding.source,
            }
          : await resolveCronAuthSelection({
              agentId,
              cfg: admittedConfig,
              provider,
              modelId: model,
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
          entry: cronSession.sessionEntry,
          cfg: admittedConfig,
        }),
        authProfileId,
        authProfileIdSource: authSelection?.source,
      };
      const runContinuationSession = usesExactRunSession
        ? createCronRunContinuationSession({
            cronSession,
            runSessionKey,
            createdActor: input.job.createdActor,
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
          resultTarget,
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
          liveSelection,
          useSubagentFallbacks,
          inheritDefaultFallbacksForAgentStringModel,
          modelFallbacksOverride,
          thinkingSelection,
          timeoutMs,
          preflightDiagnostics,
          runTimeoutOverrideMs,
          preparedModelRuntimeLease,
        },
      };
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
