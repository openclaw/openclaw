import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { resolveSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { runCliAgent } from "../../agents/cli-runner.js";
import { getCliSessionId, setCliSessionId } from "../../agents/cli-session.js";
import { lookupContextTokens } from "../../agents/context.js";
import { resolveCronStyleNow } from "../../agents/current-time.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { resolveNestedAgentLane } from "../../agents/lanes.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import {
  getModelRefStatus,
  isCliProvider,
  normalizeModelSelection,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
  resolveModelRefFromString,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import {
  countActiveDescendantRuns,
  listDescendantRunsForRequester,
} from "../../agents/subagent-registry.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../../agents/usage.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  supportsXHighThinking,
} from "../../auto-reply/thinking.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveSessionTranscriptPath,
  setSessionRuntimeModel,
  updateSessionStore,
} from "../../config/sessions.js";
import type { AgentDefaultsConfig } from "../../config/types.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { logWarn } from "../../logger.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  buildSafeExternalPrompt,
  detectSuspiciousPatterns,
  getHookType,
  isExternalHookSession,
} from "../../security/external-content.js";
import { resolveCronDeliveryPlan } from "../delivery.js";
import type { CronJob, CronRunOutcome, CronRunTelemetry } from "../types.js";
import {
  dispatchCronDelivery,
  matchesMessagingToolDeliveryTarget,
  resolveCronDeliveryBestEffort,
} from "./delivery-dispatch.js";
import { resolveDeliveryTarget } from "./delivery-target.js";
import {
  isHeartbeatOnlyResponse,
  pickLastDeliverablePayload,
  pickLastNonEmptyTextFromPayloads,
  pickSummaryFromOutput,
  pickSummaryFromPayloads,
  resolveHeartbeatAckMaxChars,
} from "./helpers.js";
import { resolveCronAgentSessionKey } from "./session-key.js";
import { resolveCronSession } from "./session.js";
import { resolveCronSkillsSnapshot } from "./skills-snapshot.js";
import { isLikelyInterimCronMessage } from "./subagent-followup.js";

export type RunCronAgentTurnResult = {
  /** Last non-empty agent text output (not truncated). */
  outputText?: string;
  /**
   * `true` when the isolated runner already handled the run's user-visible
   * delivery outcome. Cron-owned callers use this for cron delivery or
   * explicit suppression; shared callers may also use it for a matching
   * message-tool send that already reached the target.
   */
  delivered?: boolean;
  /**
   * `true` when cron attempted announce/direct delivery for this run.
   * This is tracked separately from `delivered` because some announce paths
   * cannot guarantee a final delivery ack synchronously.
   */
  deliveryAttempted?: boolean;
} & CronRunOutcome &
  CronRunTelemetry;

type ResolvedAgentConfig = NonNullable<ReturnType<typeof resolveAgentConfig>>;

function extractCronAgentDefaultsOverride(agentConfigOverride?: ResolvedAgentConfig) {
  const {
    model: overrideModel,
    sandbox: _agentSandboxOverride,
    ...agentOverrideRest
  } = agentConfigOverride ?? {};
  return {
    overrideModel,
    definedOverrides: Object.fromEntries(
      Object.entries(agentOverrideRest).filter(([, value]) => value !== undefined),
    ) as Partial<AgentDefaultsConfig>,
  };
}

function mergeCronAgentModelOverride(params: {
  defaults: AgentDefaultsConfig;
  overrideModel: ResolvedAgentConfig["model"] | undefined;
}) {
  const nextDefaults: AgentDefaultsConfig = { ...params.defaults };
  const existingModel =
    nextDefaults.model && typeof nextDefaults.model === "object" ? nextDefaults.model : {};
  if (typeof params.overrideModel === "string") {
    nextDefaults.model = { ...existingModel, primary: params.overrideModel };
  } else if (params.overrideModel) {
    nextDefaults.model = { ...existingModel, ...params.overrideModel };
  }
  return nextDefaults;
}

function buildCronAgentDefaultsConfig(params: {
  defaults?: AgentDefaultsConfig;
  agentConfigOverride?: ResolvedAgentConfig;
}) {
  const { overrideModel, definedOverrides } = extractCronAgentDefaultsOverride(
    params.agentConfigOverride,
  );
  // Keep sandbox overrides out of `agents.defaults` here. Sandbox resolution
  // already merges global defaults with per-agent overrides using `agentId`;
  // copying the agent sandbox into defaults clobbers global defaults and can
  // double-apply nested agent overrides during isolated cron runs.
  return mergeCronAgentModelOverride({
    defaults: Object.assign({}, params.defaults, definedOverrides),
    overrideModel,
  });
}

type ResolvedCronDeliveryTarget = Awaited<ReturnType<typeof resolveDeliveryTarget>>;

type IsolatedDeliveryContract = "cron-owned" | "shared";

function resolveCronToolPolicy(params: {
  deliveryRequested: boolean;
  resolvedDelivery: ResolvedCronDeliveryTarget;
  deliveryContract: IsolatedDeliveryContract;
}) {
  return {
    // Only enforce an explicit message target when the cron delivery target
    // was successfully resolved. When resolution fails the agent should not
    // be blocked by a target it cannot satisfy (#27898).
    requireExplicitMessageTarget: params.deliveryRequested && params.resolvedDelivery.ok,
    // Cron-owned runs always route user-facing delivery through the runner
    // itself. Shared callers keep the previous behavior so non-cron paths do
    // not silently lose the message tool when no explicit delivery is active.
    disableMessageTool: params.deliveryContract === "cron-owned" ? true : params.deliveryRequested,
  };
}

async function resolveCronDeliveryContext(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
  deliveryContract: IsolatedDeliveryContract;
}) {
  const deliveryPlan = resolveCronDeliveryPlan(params.job);
  const resolvedDelivery = await resolveDeliveryTarget(params.cfg, params.agentId, {
    channel: deliveryPlan.channel ?? "last",
    to: deliveryPlan.to,
    accountId: deliveryPlan.accountId,
    sessionKey: params.job.sessionKey,
  });
  return {
    deliveryPlan,
    deliveryRequested: deliveryPlan.requested,
    resolvedDelivery,
    toolPolicy: resolveCronToolPolicy({
      deliveryRequested: deliveryPlan.requested,
      resolvedDelivery,
      deliveryContract: params.deliveryContract,
    }),
  };
}

function appendCronDeliveryInstruction(params: {
  commandBody: string;
  deliveryRequested: boolean;
}) {
  if (!params.deliveryRequested) {
    return params.commandBody;
  }
  return `${params.commandBody}\n\nReturn your summary as plain text; it will be delivered automatically. If the task explicitly calls for messaging a specific external recipient, note who/where it should go instead of sending it yourself.`.trim();
}

export async function runCronIsolatedAgentTurn(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  message: string;
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
  sessionKey: string;
  agentId?: string;
  lane?: string;
  deliveryContract?: IsolatedDeliveryContract;
}): Promise<RunCronAgentTurnResult> {
  const abortSignal = params.abortSignal ?? params.signal;
  const isAborted = () => abortSignal?.aborted === true;
  const abortReason = () => {
    const reason = abortSignal?.reason;
    return typeof reason === "string" && reason.trim()
      ? reason.trim()
      : "cron: job execution timed out";
  };
  const isFastTestEnv = process.env.OPENCLAW_TEST_FAST === "1";
  const deliveryContract = params.deliveryContract ?? "cron-owned";
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const requestedAgentId =
    typeof params.agentId === "string" && params.agentId.trim()
      ? params.agentId
      : typeof params.job.agentId === "string" && params.job.agentId.trim()
        ? params.job.agentId
        : undefined;
  const normalizedRequested = requestedAgentId ? normalizeAgentId(requestedAgentId) : undefined;
  const agentConfigOverride = normalizedRequested
    ? resolveAgentConfig(params.cfg, normalizedRequested)
    : undefined;
  // Use the requested agentId even when there is no explicit agent config entry.
  // This ensures auth-profiles, workspace, and agentDir all resolve to the
  // correct per-agent paths (e.g. ~/.openclaw/agents/<agentId>/agent/).
  const agentId = normalizedRequested ?? defaultAgentId;
  const agentCfg = buildCronAgentDefaultsConfig({
    defaults: params.cfg.agents?.defaults,
    agentConfigOverride,
  });
  const cfgWithAgentDefaults: OpenClawConfig = {
    ...params.cfg,
    agents: Object.assign({}, params.cfg.agents, { defaults: agentCfg }),
  };

  const baseSessionKey = (params.sessionKey?.trim() || `cron:${params.job.id}`).trim();
  const agentSessionKey = resolveCronAgentSessionKey({ sessionKey: baseSessionKey, agentId });

  const workspaceDirRaw = resolveAgentWorkspaceDir(params.cfg, agentId);
  const agentDir = resolveAgentDir(params.cfg, agentId);
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap && !isFastTestEnv,
  });
  const workspaceDir = workspace.dir;

  const resolvedDefault = resolveConfiguredModelRef({
    cfg: cfgWithAgentDefaults,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  let provider = resolvedDefault.provider;
  let model = resolvedDefault.model;

  let catalog: Awaited<ReturnType<typeof loadModelCatalog>> | undefined;
  const loadCatalog = async () => {
    if (!catalog) {
      catalog = await loadModelCatalog({ config: cfgWithAgentDefaults });
    }
    return catalog;
  };
  // Isolated cron sessions are subagents — prefer subagents.model when set,
  // but only if it passes the model allowlist.  #11461
  const subagentModelRaw =
    normalizeModelSelection(agentConfigOverride?.subagents?.model) ??
    normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model);
  if (subagentModelRaw) {
    const resolvedSubagent = resolveAllowedModelRef({
      cfg: cfgWithAgentDefaults,
      catalog: await loadCatalog(),
      raw: subagentModelRaw,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if (!("error" in resolvedSubagent)) {
      provider = resolvedSubagent.ref.provider;
      model = resolvedSubagent.ref.model;
    }
  }
  // Resolve model - prefer hooks.gmail.model for Gmail hooks.
  const isGmailHook = baseSessionKey.startsWith("hook:gmail:");
  let hooksGmailModelApplied = false;
  const hooksGmailModelRef = isGmailHook
    ? resolveHooksGmailModel({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
      })
    : null;
  if (hooksGmailModelRef) {
    const status = getModelRefStatus({
      cfg: params.cfg,
      catalog: await loadCatalog(),
      ref: hooksGmailModelRef,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if (status.allowed) {
      provider = hooksGmailModelRef.provider;
      model = hooksGmailModelRef.model;
      hooksGmailModelApplied = true;
    }
  }
  const modelOverrideRaw =
    params.job.payload.kind === "agentTurn" ? params.job.payload.model : undefined;
  const modelOverride = typeof modelOverrideRaw === "string" ? modelOverrideRaw.trim() : undefined;
  if (modelOverride !== undefined && modelOverride.length > 0) {
    const resolvedOverride = resolveAllowedModelRef({
      cfg: cfgWithAgentDefaults,
      catalog: await loadCatalog(),
      raw: modelOverride,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if ("error" in resolvedOverride) {
      if (resolvedOverride.error.startsWith("model not allowed:")) {
        // #36326: Payload model overrides come from trusted admin-controlled
        // sources (cron config, hook transforms, API).  Honour them even when
        // they are not in agents.defaults.models so that hook transform model
        // overrides work as expected.  The interactive /model allowlist still
        // gates session-level overrides separately.
        const parsed = resolveModelRefFromString({
          raw: modelOverride,
          defaultProvider: resolvedDefault.provider,
        });
        if (parsed) {
          provider = parsed.ref.provider;
          model = parsed.ref.model;
          logWarn(`cron: payload.model '${modelOverride}' not in model allowlist, using as-is`);
        } else {
          logWarn(
            `cron: payload.model '${modelOverride}' could not be parsed, falling back to agent defaults`,
          );
        }
      } else {
        return { status: "error", error: resolvedOverride.error };
      }
    } else {
      provider = resolvedOverride.ref.provider;
      model = resolvedOverride.ref.model;
    }
  }
  const now = Date.now();
  const cronSession = resolveCronSession({
    cfg: params.cfg,
    sessionKey: agentSessionKey,
    agentId,
    nowMs: now,
    // Isolated cron runs must not carry prior turn context across executions.
    forceNew: params.job.sessionTarget === "isolated",
  });
  const runSessionId = cronSession.sessionEntry.sessionId;
  const runSessionKey = baseSessionKey.startsWith("cron:")
    ? `${agentSessionKey}:run:${runSessionId}`
    : agentSessionKey;
  const persistSessionEntry = async () => {
    if (isFastTestEnv) {
      return;
    }
    cronSession.store[agentSessionKey] = cronSession.sessionEntry;
    if (runSessionKey !== agentSessionKey) {
      cronSession.store[runSessionKey] = cronSession.sessionEntry;
    }
    await updateSessionStore(cronSession.storePath, (store) => {
      store[agentSessionKey] = cronSession.sessionEntry;
      if (runSessionKey !== agentSessionKey) {
        store[runSessionKey] = cronSession.sessionEntry;
      }
    });
  };
  const withRunSession = (
    result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
  ): RunCronAgentTurnResult => ({
    ...result,
    sessionId: runSessionId,
    sessionKey: runSessionKey,
  });
  if (!cronSession.sessionEntry.label?.trim() && baseSessionKey.startsWith("cron:")) {
    const labelSuffix =
      typeof params.job.name === "string" && params.job.name.trim()
        ? params.job.name.trim()
        : params.job.id;
    cronSession.sessionEntry.label = `Cron: ${labelSuffix}`;
  }

  // Respect session model override — check session.modelOverride before falling
  // back to the default config model. This ensures /model changes are honoured
  // by cron and isolated agent runs.
  if (!modelOverride && !hooksGmailModelApplied) {
    const sessionModelOverride = cronSession.sessionEntry.modelOverride?.trim();
    if (sessionModelOverride) {
      const sessionProviderOverride =
        cronSession.sessionEntry.providerOverride?.trim() || resolvedDefault.provider;
      const resolvedSessionOverride = resolveAllowedModelRef({
        cfg: cfgWithAgentDefaults,
        catalog: await loadCatalog(),
        raw: `${sessionProviderOverride}/${sessionModelOverride}`,
        defaultProvider: resolvedDefault.provider,
        defaultModel: resolvedDefault.model,
      });
      if (!("error" in resolvedSessionOverride)) {
        provider = resolvedSessionOverride.ref.provider;
        model = resolvedSessionOverride.ref.model;
      }
    }
  }

  // Resolve thinking level - job thinking > hooks.gmail.thinking > model/global defaults
  const hooksGmailThinking = isGmailHook
    ? normalizeThinkLevel(params.cfg.hooks?.gmail?.thinking)
    : undefined;
  const jobThink = normalizeThinkLevel(
    (params.job.payload.kind === "agentTurn" ? params.job.payload.thinking : undefined) ??
      undefined,
  );
  let thinkLevel = jobThink ?? hooksGmailThinking;
  if (!thinkLevel) {
    thinkLevel = resolveThinkingDefault({
      cfg: cfgWithAgentDefaults,
      provider,
      model,
      catalog: await loadCatalog(),
    });
  }
  if (thinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
    logWarn(
      `[cron:${params.job.id}] Thinking level "xhigh" is not supported for ${provider}/${model}; downgrading to "high".`,
    );
    thinkLevel = "high";
  }

  const timeoutMs = resolveAgentTimeoutMs({
    cfg: cfgWithAgentDefaults,
    overrideSeconds:
      params.job.payload.kind === "agentTurn" ? params.job.payload.timeoutSeconds : undefined,
  });

  const agentPayload = params.job.payload.kind === "agentTurn" ? params.job.payload : null;
  const { deliveryRequested, resolvedDelivery, toolPolicy } = await resolveCronDeliveryContext({
    cfg: cfgWithAgentDefaults,
    job: params.job,
    agentId,
    deliveryContract,
  });

  const { formattedTime, timeLine } = resolveCronStyleNow(params.cfg, now);
  const base = `[cron:${params.job.id} ${params.job.name}] ${params.message}`.trim();

  // SECURITY: Wrap external hook content with security boundaries to prevent prompt injection
  // unless explicitly allowed via a dangerous config override.
  const isExternalHook = isExternalHookSession(baseSessionKey);
  const allowUnsafeExternalContent =
    agentPayload?.allowUnsafeExternalContent === true ||
    (isGmailHook && params.cfg.hooks?.gmail?.allowUnsafeExternalContent === true);
  const shouldWrapExternal = isExternalHook && !allowUnsafeExternalContent;
  let commandBody: string;

  if (isExternalHook) {
    // Log suspicious patterns for security monitoring
    const suspiciousPatterns = detectSuspiciousPatterns(params.message);
    if (suspiciousPatterns.length > 0) {
      logWarn(
        `[security] Suspicious patterns detected in external hook content ` +
          `(session=${baseSessionKey}, patterns=${suspiciousPatterns.length}): ${suspiciousPatterns.slice(0, 3).join(", ")}`,
      );
    }
  }

  if (shouldWrapExternal) {
    // Wrap external content with security boundaries
    const hookType = getHookType(baseSessionKey);
    const safeContent = buildSafeExternalPrompt({
      content: params.message,
      source: hookType,
      jobName: params.job.name,
      jobId: params.job.id,
      timestamp: formattedTime,
    });

    commandBody = `${safeContent}\n\n${timeLine}`.trim();
  } else {
    // Internal/trusted source - use original format
    commandBody = `${base}\n${timeLine}`.trim();
  }
  commandBody = appendCronDeliveryInstruction({ commandBody, deliveryRequested });

  const existingSkillsSnapshot = cronSession.sessionEntry.skillsSnapshot;
  const skillsSnapshot = resolveCronSkillsSnapshot({
    workspaceDir,
    config: cfgWithAgentDefaults,
    agentId,
    existingSnapshot: existingSkillsSnapshot,
    isFastTestEnv,
  });
  if (!isFastTestEnv && skillsSnapshot !== existingSkillsSnapshot) {
    cronSession.sessionEntry = {
      ...cronSession.sessionEntry,
      updatedAt: Date.now(),
      skillsSnapshot,
    };
    await persistSessionEntry();
  }

  // Persist the intended model and systemSent before the run so that
  // sessions_list reflects the cron override even if the run fails or is
  // still in progress (#21057).  Best-effort: a filesystem error here
  // must not prevent the actual agent run from executing.
  cronSession.sessionEntry.modelProvider = provider;
  cronSession.sessionEntry.model = model;
  cronSession.sessionEntry.systemSent = true;
  try {
    await persistSessionEntry();
  } catch (err) {
    logWarn(`[cron:${params.job.id}] Failed to persist pre-run session entry: ${String(err)}`);
  }

  // Resolve auth profile for the session, mirroring the inbound auto-reply path
  // (get-reply-run.ts). Without this, isolated cron sessions fall back to env-var
  // auth which may not match the configured auth-profiles, causing 401 errors.
  const authProfileId = await resolveSessionAuthProfileOverride({
    cfg: cfgWithAgentDefaults,
    provider,
    agentDir,
    sessionEntry: cronSession.sessionEntry,
    sessionStore: cronSession.store,
    sessionKey: agentSessionKey,
    storePath: cronSession.storePath,
    isNewSession: cronSession.isNewSession,
  });
  const authProfileIdSource = cronSession.sessionEntry.authProfileOverrideSource;

  let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>> | undefined;
  let fallbackProvider = provider;
  let fallbackModel = model;
  const runStartedAt = Date.now();
  let runEndedAt = runStartedAt;
  try {
    const sessionFile = resolveSessionTranscriptPath(cronSession.sessionEntry.sessionId, agentId);
    const resolvedVerboseLevel =
      normalizeVerboseLevel(cronSession.sessionEntry.verboseLevel) ??
      normalizeVerboseLevel(agentCfg?.verboseDefault) ??
      "off";
    registerAgentRunContext(cronSession.sessionEntry.sessionId, {
      sessionKey: agentSessionKey,
      verboseLevel: resolvedVerboseLevel,
    });
    const messageChannel = resolvedDelivery.channel;
    // Per-job payload.fallbacks takes priority over agent-level fallbacks.
    const payloadFallbacks =
      params.job.payload.kind === "agentTurn" && Array.isArray(params.job.payload.fallbacks)
        ? params.job.payload.fallbacks
        : undefined;
    let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
      cronSession.sessionEntry.systemPromptReport,
    );

    const runPrompt = async (promptText: string) => {
      const fallbackResult = await runWithModelFallback({
        cfg: cfgWithAgentDefaults,
        provider,
        model,
        runId: cronSession.sessionEntry.sessionId,
        agentDir,
        fallbacksOverride:
          payloadFallbacks ?? resolveAgentModelFallbacksOverride(params.cfg, agentId),
        run: async (providerOverride, modelOverride, runOptions) => {
          if (abortSignal?.aborted) {
            throw new Error(abortReason());
          }
          const bootstrapPromptWarningSignature =
            bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1];
          if (isCliProvider(providerOverride, cfgWithAgentDefaults)) {
            // Fresh isolated cron sessions must not reuse a stored CLI session ID.
            // Passing an existing ID activates the resume watchdog profile
            // (noOutputTimeoutRatio 0.3, maxMs 180 s) instead of the fresh profile
            // (ratio 0.8, maxMs 600 s), causing jobs to time out at roughly 1/3 of
            // the configured timeoutSeconds. See: https://github.com/openclaw/openclaw/issues/29774
            const cliSessionId = cronSession.isNewSession
              ? undefined
              : getCliSessionId(cronSession.sessionEntry, providerOverride);
            const result = await runCliAgent({
              sessionId: cronSession.sessionEntry.sessionId,
              sessionKey: agentSessionKey,
              agentId,
              sessionFile,
              workspaceDir,
              config: cfgWithAgentDefaults,
              prompt: promptText,
              provider: providerOverride,
              model: modelOverride,
              thinkLevel,
              timeoutMs,
              runId: cronSession.sessionEntry.sessionId,
              cliSessionId,
              bootstrapPromptWarningSignaturesSeen,
              bootstrapPromptWarningSignature,
            });
            bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
              result.meta?.systemPromptReport,
            );
            return result;
          }
          const result = await runEmbeddedPiAgent({
            sessionId: cronSession.sessionEntry.sessionId,
            sessionKey: agentSessionKey,
            agentId,
            trigger: "cron",
            // Cron jobs are trusted local automation, so isolated runs should
            // inherit owner-only tooling like local `openclaw agent` runs.
            senderIsOwner: true,
            messageChannel,
            agentAccountId: resolvedDelivery.accountId,
            sessionFile,
            agentDir,
            workspaceDir,
            config: cfgWithAgentDefaults,
            skillsSnapshot,
            prompt: promptText,
            lane: resolveNestedAgentLane(params.lane),
            provider: providerOverride,
            model: modelOverride,
            authProfileId,
            authProfileIdSource,
            thinkLevel,
            fastMode: resolveFastModeState({
              cfg: cfgWithAgentDefaults,
              provider: providerOverride,
              model: modelOverride,
              sessionEntry: cronSession.sessionEntry,
            }).enabled,
            verboseLevel: resolvedVerboseLevel,
            timeoutMs,
            bootstrapContextMode: agentPayload?.lightContext ? "lightweight" : undefined,
            bootstrapContextRunKind: "cron",
            runId: cronSession.sessionEntry.sessionId,
            requireExplicitMessageTarget: toolPolicy.requireExplicitMessageTarget,
            disableMessageTool: toolPolicy.disableMessageTool,
            allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
            abortSignal,
            bootstrapPromptWarningSignaturesSeen,
            bootstrapPromptWarningSignature,
          });
          bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
            result.meta?.systemPromptReport,
          );
          return result;
        },
      });
      runResult = fallbackResult.result;
      fallbackProvider = fallbackResult.provider;
      fallbackModel = fallbackResult.model;
      provider = fallbackResult.provider;
      model = fallbackResult.model;
      runEndedAt = Date.now();
    };

    await runPrompt(commandBody);
    if (!runResult) {
      throw new Error("cron isolated run returned no result");
    }

    // Guardrail for cron jobs: if the first turn is only an interim ack
    // (e.g. "on it") and no descendants are active, run one focused follow-up
    // turn so the cron run returns an actual completion.
    if (!isAborted()) {
      const interimRunResult = runResult;
      const interimPayloads = interimRunResult.payloads ?? [];
      const interimDeliveryPayload = pickLastDeliverablePayload(interimPayloads);
      const interimPayloadHasStructuredContent =
        Boolean(interimDeliveryPayload?.mediaUrl) ||
        (interimDeliveryPayload?.mediaUrls?.length ?? 0) > 0 ||
        Object.keys(interimDeliveryPayload?.channelData ?? {}).length > 0;
      const interimText = pickLastNonEmptyTextFromPayloads(interimPayloads)?.trim() ?? "";
      const hasDescendantsSinceRunStart = listDescendantRunsForRequester(agentSessionKey).some(
        (entry) => {
          const descendantStartedAt =
            typeof entry.startedAt === "number" ? entry.startedAt : entry.createdAt;
          return typeof descendantStartedAt === "number" && descendantStartedAt >= runStartedAt;
        },
      );
      const shouldRetryInterimAck =
        !interimRunResult.meta?.error &&
        !interimRunResult.didSendViaMessagingTool &&
        !interimPayloadHasStructuredContent &&
        !interimPayloads.some((payload) => payload?.isError === true) &&
        countActiveDescendantRuns(agentSessionKey) === 0 &&
        !hasDescendantsSinceRunStart &&
        isLikelyInterimCronMessage(interimText);

      if (shouldRetryInterimAck) {
        const continuationPrompt = [
          "Your previous response was only an acknowledgement and did not complete this cron task.",
          "Complete the original task now.",
          "Do not send a status update like 'on it'.",
          "Use tools when needed, including sessions_spawn for parallel subtasks, wait for spawned subagents to finish, then return only the final summary.",
        ].join(" ");
        await runPrompt(continuationPrompt);
      }
    }
  } catch (err) {
    return withRunSession({ status: "error", error: String(err) });
  }

  if (isAborted()) {
    return withRunSession({ status: "error", error: abortReason() });
  }
  if (!runResult) {
    return withRunSession({ status: "error", error: "cron isolated run returned no result" });
  }
  const finalRunResult = runResult;
  const payloads = finalRunResult.payloads ?? [];

  // Update token+model fields in the session store.
  // Also collect best-effort telemetry for the cron run log.
  let telemetry: CronRunTelemetry | undefined;
  {
    if (finalRunResult.meta?.systemPromptReport) {
      cronSession.sessionEntry.systemPromptReport = finalRunResult.meta.systemPromptReport;
    }
    const usage = finalRunResult.meta?.agentMeta?.usage;
    const promptTokens = finalRunResult.meta?.agentMeta?.promptTokens;
    const modelUsed = finalRunResult.meta?.agentMeta?.model ?? fallbackModel ?? model;
    const providerUsed = finalRunResult.meta?.agentMeta?.provider ?? fallbackProvider ?? provider;
    const contextTokens =
      agentCfg?.contextTokens ?? lookupContextTokens(modelUsed) ?? DEFAULT_CONTEXT_TOKENS;

    setSessionRuntimeModel(cronSession.sessionEntry, {
      provider: providerUsed,
      model: modelUsed,
    });
    cronSession.sessionEntry.contextTokens = contextTokens;
    if (isCliProvider(providerUsed, cfgWithAgentDefaults)) {
      const cliSessionId = finalRunResult.meta?.agentMeta?.sessionId?.trim();
      if (cliSessionId) {
        setCliSessionId(cronSession.sessionEntry, providerUsed, cliSessionId);
      }
    }
    if (hasNonzeroUsage(usage)) {
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const totalTokens = deriveSessionTotalTokens({
        usage,
        contextTokens,
        promptTokens,
      });
      cronSession.sessionEntry.inputTokens = input;
      cronSession.sessionEntry.outputTokens = output;
      const telemetryUsage: NonNullable<CronRunTelemetry["usage"]> = {
        input_tokens: input,
        output_tokens: output,
      };
      if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
        cronSession.sessionEntry.totalTokens = totalTokens;
        cronSession.sessionEntry.totalTokensFresh = true;
        telemetryUsage.total_tokens = totalTokens;
      } else {
        cronSession.sessionEntry.totalTokens = undefined;
        cronSession.sessionEntry.totalTokensFresh = false;
      }
      cronSession.sessionEntry.cacheRead = usage.cacheRead ?? 0;
      cronSession.sessionEntry.cacheWrite = usage.cacheWrite ?? 0;

      telemetry = {
        model: modelUsed,
        provider: providerUsed,
        usage: telemetryUsage,
      };
    } else {
      telemetry = {
        model: modelUsed,
        provider: providerUsed,
      };
    }
    await persistSessionEntry();
  }

  if (isAborted()) {
    return withRunSession({ status: "error", error: abortReason(), ...telemetry });
  }
  const firstText = payloads[0]?.text ?? "";
  let summary = pickSummaryFromPayloads(payloads) ?? pickSummaryFromOutput(firstText);
  let outputText = pickLastNonEmptyTextFromPayloads(payloads);
  let synthesizedText = outputText?.trim() || summary?.trim() || undefined;
  const deliveryPayload = pickLastDeliverablePayload(payloads);
  let deliveryPayloads =
    deliveryPayload !== undefined
      ? [deliveryPayload]
      : synthesizedText
        ? [{ text: synthesizedText }]
        : [];
  const deliveryPayloadHasStructuredContent =
    Boolean(deliveryPayload?.mediaUrl) ||
    (deliveryPayload?.mediaUrls?.length ?? 0) > 0 ||
    Object.keys(deliveryPayload?.channelData ?? {}).length > 0;
  const deliveryBestEffort = resolveCronDeliveryBestEffort(params.job);
  const hasErrorPayload = payloads.some((payload) => payload?.isError === true);
  const runLevelError = finalRunResult.meta?.error;
  const lastErrorPayloadIndex = payloads.findLastIndex((payload) => payload?.isError === true);
  const hasSuccessfulPayloadAfterLastError =
    !runLevelError &&
    lastErrorPayloadIndex >= 0 &&
    payloads
      .slice(lastErrorPayloadIndex + 1)
      .some((payload) => payload?.isError !== true && Boolean(payload?.text?.trim()));
  // Tool wrappers can emit transient/false-positive error payloads before a valid final
  // assistant payload.  Only treat payload errors as recoverable when (a) the run itself
  // did not report a model/context-level error and (b) a non-error payload follows.
  const hasFatalErrorPayload = hasErrorPayload && !hasSuccessfulPayloadAfterLastError;
  const lastErrorPayloadText = [...payloads]
    .toReversed()
    .find((payload) => payload?.isError === true && Boolean(payload?.text?.trim()))
    ?.text?.trim();
  const embeddedRunError = hasFatalErrorPayload
    ? (lastErrorPayloadText ?? "cron isolated run returned an error payload")
    : undefined;
  const resolveRunOutcome = (params?: { delivered?: boolean; deliveryAttempted?: boolean }) =>
    withRunSession({
      status: hasFatalErrorPayload ? "error" : "ok",
      ...(hasFatalErrorPayload
        ? { error: embeddedRunError ?? "cron isolated run returned an error payload" }
        : {}),
      summary,
      outputText,
      delivered: params?.delivered,
      deliveryAttempted: params?.deliveryAttempted,
      ...telemetry,
    });

  // Skip delivery for heartbeat-only responses (HEARTBEAT_OK with no real content).
  const ackMaxChars = resolveHeartbeatAckMaxChars(agentCfg);
  const skipHeartbeatDelivery = deliveryRequested && isHeartbeatOnlyResponse(payloads, ackMaxChars);
  const skipMessagingToolDelivery =
    deliveryContract === "shared" &&
    deliveryRequested &&
    finalRunResult.didSendViaMessagingTool === true &&
    (finalRunResult.messagingToolSentTargets ?? []).some((target) =>
      matchesMessagingToolDeliveryTarget(target, {
        channel: resolvedDelivery.channel,
        to: resolvedDelivery.to,
        accountId: resolvedDelivery.accountId,
      }),
    );
  const deliveryResult = await dispatchCronDelivery({
    cfg: params.cfg,
    cfgWithAgentDefaults,
    deps: params.deps,
    job: params.job,
    agentId,
    agentSessionKey,
    runSessionId,
    runStartedAt,
    runEndedAt,
    timeoutMs,
    resolvedDelivery,
    deliveryRequested,
    skipHeartbeatDelivery,
    skipMessagingToolDelivery,
    deliveryBestEffort,
    deliveryPayloadHasStructuredContent,
    deliveryPayloads,
    synthesizedText,
    summary,
    outputText,
    telemetry,
    abortSignal,
    isAborted,
    abortReason,
    withRunSession,
  });
  if (deliveryResult.result) {
    const resultWithDeliveryMeta: RunCronAgentTurnResult = {
      ...deliveryResult.result,
      deliveryAttempted:
        deliveryResult.result.deliveryAttempted ?? deliveryResult.deliveryAttempted,
    };
    if (!hasFatalErrorPayload || deliveryResult.result.status !== "ok") {
      return resultWithDeliveryMeta;
    }
    return resolveRunOutcome({
      delivered: deliveryResult.result.delivered,
      deliveryAttempted: resultWithDeliveryMeta.deliveryAttempted,
    });
  }
  const delivered = deliveryResult.delivered;
  const deliveryAttempted = deliveryResult.deliveryAttempted;
  summary = deliveryResult.summary;
  outputText = deliveryResult.outputText;

  return resolveRunOutcome({ delivered, deliveryAttempted });
}
