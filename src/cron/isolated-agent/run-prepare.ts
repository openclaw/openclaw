/** Session identity and context preparation for isolated cron runs. */
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope.js";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
import type { LiveSessionModelSelection } from "../../agents/live-model-switch.js";
import { findModelInCatalog } from "../../agents/model-catalog-lookup.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  type PreparedModelRuntimeLease,
} from "../../agents/prepared-model-runtime.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveCreatorSandbox } from "../../gateway/operator-role-policy.js";
import { isCronSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
} from "../../sessions/agent-harness-session-key.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { resolveCronSkillsSnapshot } from "../../skills/runtime/cron-snapshot.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import { resolveCronScheduledToolPolicy } from "../scheduled-tool-policy.js";
import { isDetachedCronSessionTarget } from "../session-target.js";
import { resolveCronRunToolsAllow } from "../tools-allow.js";
import {
  resolveCronModelSelection,
  resolveCronModelSelectionOwner,
  resolveCronThinkingSelection,
} from "./model-selection.js";
import { resolveCronCommandPromptPreflight } from "./run-command-preflight.js";
import { resolveCronActiveRuntimeConfig, resolveCronAgentConfig } from "./run-config.js";
import { buildCurrentConversationContextBlock } from "./run-current-context.js";
import {
  createCronToolsAllowPreflightDiagnostics,
  resolveCronDeliveryContext,
} from "./run-delivery-trace.js";
import { resolveCronPreflight } from "./run-fallback-policy.js";
import {
  appendCronUnattendedRunPreamble,
  resolveCronAuthSelection,
  loadCronExternalContentRuntime,
  loadSessionAccessorRuntime,
  retireRolledCronSessionMcpRuntime,
  type RunCronAgentTurnParams,
  type WithRunSession,
} from "./run-prepare-runtime.js";
import {
  CronSessionLifecycleClaimError,
  beginCronSessionWorkAdmission,
  withCronSessionPreparation,
  createCronRunContinuationSession,
  createPersistCronSessionEntry,
  setCronSessionRuntimeModel,
  persistCronSkillsSnapshotIfChanged,
  type CronSessionRowWriter,
} from "./run-session-state.js";
import { resolveCronRunTimeoutOverrideMs } from "./run-timeout.js";
import { prepareCronSessionWorkspace, type CronWorkspaceLease } from "./run-workspace.js";
import {
  isExternalHookSession,
  logWarn,
  mapHookExternalContentSource,
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

export type PreparedCronRunContext = Extract<
  Awaited<ReturnType<typeof prepareCronRunContext>>,
  { ok: true }
>["context"];

export async function prepareCronRunContext(params: {
  input: RunCronAgentTurnParams;
  isFastTestEnv: boolean;
  onLifecycleInterrupt: () => void;
}) {
  const { input } = params;
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
  const publishedRuntime = await loadPublishedGatewayReplyDispatchRuntime({
    agentId: initialAgentId,
    demand: "scheduled",
    abortSignal: input.abortSignal ?? input.signal,
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
  return await withCronSessionPreparation(
    {
      storePath: resolveSessionStorePathCore(runtimeCfg.session?.store, { agentId }),
      sessionKey: agentSessionKey,
      signal: input.abortSignal ?? input.signal,
      onInterrupt: params.onLifecycleInterrupt,
      onLaneWait: input.onLaneWait,
    },
    prepareAdmittedSession,
  );

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
    const completionSource =
      input.job.sessionTarget === "isolated" ? input.job.sourceConversation : sourceEntry;
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
    const sessionWorkAdmission = await beginCronSessionWorkAdmission({
      cronSession,
      agentSessionKey,
      runSessionKey,
      signal: input.abortSignal ?? input.signal,
      onInterrupt: params.onLifecycleInterrupt,
    });

    clearBootstrapSnapshotOnSessionRollover({
      sessionKey: agentSessionKey,
      previousSessionId: cronSession.previousSessionId,
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
        sessionWorkAdmission,
        isFastTestEnv: params.isFastTestEnv,
      });
      workspaceLease = selectedWorkspace.lease;
      const workspaceDir = selectedWorkspace.workspaceDir;
      const persistCronSessionRow: CronSessionRowWriter = async ({
        storePath,
        sessionKey,
        fallbackEntry,
        resetBoundary,
        update,
        assertCommitAllowed,
      }) => {
        const { applySessionEntryLifecycleMutation, patchSessionEntryCore } =
          await loadSessionAccessorRuntime();
        if (resetBoundary) {
          await applySessionEntryLifecycleMutation({
            activeSessionKey: sessionKey,
            agentId,
            storePath,
            upserts: [
              {
                sessionKey,
                resetBoundary,
                buildEntry: ({ currentEntry }) => update(currentEntry),
              },
            ],
            skipMaintenance: true,
          });
          return;
        }
        // Guarded replace reads the freshest row so lifecycle claims reject stale owners.
        await patchSessionEntryCore(
          { storePath, sessionKey, agentId },
          (_entry, context) => update(context.existingEntry),
          {
            fallbackEntry,
            replaceEntry: true,
            workerGuard: { assertCurrent: assertCommitAllowed },
          },
        );
      };
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
        payload: input.job.payload,
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
      const ownerAgentConfig = resolveAgentConfig(modelOwner.config, modelOwner.agentId);
      const matchesDefaultFallbackAgentStringModel =
        typeof ownerAgentConfig?.model === "string" &&
        resolveAgentModelPrimaryValue(ownerAgentConfig.model) ===
          resolveAgentModelPrimaryValue(modelOwner.config.agents?.defaults?.model);
      const useSubagentFallbacks = resolvedModelSelection.modelSource === "subagent";
      const inheritDefaultFallbacksForAgentStringModel =
        matchesDefaultFallbackAgentStringModel &&
        (resolvedModelSelection.modelSource === "default" ||
          resolvedModelSelection.modelSource === "agent");

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
          config: cfgWithAgentDefaults,
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
      const configuredProvider = cfgWithAgentDefaults.models?.providers?.[provider];
      const modelApi =
        findModelInCatalog(thinkingSelection.catalog, provider, model)?.api ??
        configuredProvider?.models?.find((candidate) => candidate.id === model)?.api ??
        configuredProvider?.api;
      const preflightDiagnostics = await createCronToolsAllowPreflightDiagnostics({
        cfg: cfgWithAgentDefaults,
        jobId: input.job.id,
        provider,
        model,
        modelApi,
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
        cfg: cfgWithAgentDefaults,
        job: input.job,
        agentId,
      });

      const { formattedTime, timeLine } = resolveCronStyleNow(runtimeCfg, now);
      // Current jobs stay detached; a bounded tail preserves context without transcript continuation.
      const currentConversationContext =
        input.job.sessionTarget === "current" && agentPayload && sourceSessionKey && sourceEntry
          ? await buildCurrentConversationContextBlock({
              agentId,
              sourceSessionEntry: sourceEntry,
              sourceSessionKey,
              storePath: cronSession.storePath,
            })
          : undefined;
      const turnMessage =
        input.job.payload.kind === "agentTurn" ? input.job.payload.message : input.message;
      const message = currentConversationContext
        ? `${currentConversationContext}\n\n${turnMessage}`
        : turnMessage;
      const sourcePromptPrefix = `[cron:${input.job.id} ${input.job.name}]`;
      const base = `${sourcePromptPrefix} ${message}`.trim();
      const isExternalHook =
        hookExternalContentSource !== undefined || isExternalHookSession(baseSessionKey);
      const allowUnsafeExternalContent =
        agentPayload?.allowUnsafeExternalContent === true ||
        (isGmailHook && input.cfg.hooks?.gmail?.allowUnsafeExternalContent === true);
      const shouldWrapExternal = isExternalHook && !allowUnsafeExternalContent;
      let commandBody: string;

      if (isExternalHook) {
        const { detectSuspiciousPatterns } = await loadCronExternalContentRuntime();
        const suspiciousPatterns = detectSuspiciousPatterns(message);
        if (suspiciousPatterns.length > 0) {
          logWarn(
            `[security] Suspicious patterns detected in external hook content ` +
              `(session=${baseSessionKey}, patterns=${suspiciousPatterns.length}): ${suspiciousPatterns.slice(0, 3).join(", ")}`,
          );
        }
      }

      if (shouldWrapExternal) {
        const { buildSafeExternalPrompt } = await loadCronExternalContentRuntime();
        const hookType = mapHookExternalContentSource(hookExternalContentSource ?? "webhook");
        const safeContent = buildSafeExternalPrompt({
          content: message,
          source: hookType,
          jobName: input.job.name,
          jobId: input.job.id,
          timestamp: formattedTime,
        });
        commandBody = `${safeContent}\n\n${timeLine}`.trim();
      } else {
        commandBody = `${base}\n${timeLine}`.trim();
      }
      commandBody = appendCronUnattendedRunPreamble(commandBody, {
        externalHook: isExternalHook,
      });

      const skillsSnapshot = await resolveCronSkillsSnapshot({
        workspaceDir,
        config: cfgWithAgentDefaults,
        agentId,
        existingSnapshot: cronSession.sessionEntry.skillsSnapshot,
        librarySelections: cronSession.sessionEntry.skillLibrarySelections,
        isFastTestEnv: params.isFastTestEnv,
      });
      await persistCronSkillsSnapshotIfChanged({
        isFastTestEnv: params.isFastTestEnv,
        cronSession,
        skillsSnapshot,
        nowMs: Date.now(),
        persistSessionEntry,
      });

      setCronSessionRuntimeModel({ entry: cronSession.sessionEntry, provider, model });
      cronSession.sessionEntry.systemSent = true;
      try {
        await persistSessionEntry();
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
      const authSelection = await resolveCronAuthSelection({
        agentId,
        cfg: cfgWithAgentDefaults,
        provider,
        modelId: model,
        ...(provider === resolvedModelSelection.provider &&
        resolvedModelSelection.configuredProfileId
          ? { configuredProfileId: resolvedModelSelection.configuredProfileId }
          : {}),
        harnessRuntime: effectiveAgentRuntime,
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
          cfg: cfgWithAgentDefaults,
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
            cliSessionBindingFacts: {
              extraSystemPromptStatic: deliverySystemPrompt,
              sourceReplyDeliveryMode: sourceDelivery.sourceReplyDeliveryMode,
              requireExplicitMessageTarget: sourceDelivery.messageTool.requireExplicitTarget,
            },
            persistSessionEntry: persistCronSessionRow,
          })
        : undefined;
      await runContinuationSession?.initialize();

      workspaceLeaseTransferred = true;
      return {
        ok: true as const,
        context: {
          input,
          cfgWithAgentDefaults,
          agentId,
          agentCfg,
          agentDir,
          agentSessionKey,
          sourceSessionKey:
            input.job.sessionTarget === "isolated"
              ? input.job.sourceConversation?.sessionKey
              : sourceSessionKey,
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
          sessionWorkAdmission,
          persistSessionEntry,
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
        sessionWorkAdmission.release();
        await workspaceLease?.release();
      }
    }
  }
}
