import type { MessagingToolSend } from "../../agents/pi-embedded-messaging.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { AgentDefaultsConfig } from "../../config/types.js";
import type { CronJob } from "../types.js";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentModelFallbacksOverride,
  resolveAgentSkillsFilter,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { runCliAgent } from "../../agents/cli-runner.js";
import { getCliSessionId, setCliSessionId } from "../../agents/cli-session.js";
import { lookupContextTokens } from "../../agents/context.js";
import { resolveCronStyleNow } from "../../agents/current-time.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import {
  getModelRefStatus,
  isCliProvider,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { buildWorkspaceSkillSnapshot } from "../../agents/skills.js";
import { getSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import { runSubagentAnnounceFlow } from "../../agents/subagent-announce.js";
import {
  countActiveDescendantRuns,
  listDescendantRunsForRequester,
} from "../../agents/subagent-registry.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { readLatestAssistantReply } from "../../agents/tools/agent-step.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../../agents/usage.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  supportsXHighThinking,
} from "../../auto-reply/thinking.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { createOutboundSendDeps, type CliDeps } from "../../cli/outbound-send-deps.js";
import {
  resolveAgentMainSessionKey,
  resolveSessionTranscriptPath,
  updateSessionStore,
} from "../../config/sessions.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { resolveAgentOutboundIdentity } from "../../infra/outbound/identity.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { logWarn } from "../../logger.js";
import { buildAgentMainSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import {
  buildSafeExternalPrompt,
  detectSuspiciousPatterns,
  getHookType,
  isExternalHookSession,
} from "../../security/external-content.js";
import { resolveCronDeliveryPlan } from "../delivery.js";
import { resolveDeliveryTarget } from "./delivery-target.js";
import {
  isHeartbeatOnlyResponse,
  pickLastDeliverablePayload,
  pickLastNonEmptyTextFromPayloads,
  pickSummaryFromOutput,
  pickSummaryFromPayloads,
  resolveHeartbeatAckMaxChars,
} from "./helpers.js";
import { resolveCronSession } from "./session.js";

function matchesMessagingToolDeliveryTarget(
  target: MessagingToolSend,
  delivery: { channel: string; to?: string; accountId?: string },
): boolean {
  if (!delivery.to || !target.to) {
    return false;
  }
  const channel = delivery.channel.trim().toLowerCase();
  const provider = target.provider?.trim().toLowerCase();
  if (provider && provider !== "message" && provider !== channel) {
    return false;
  }
  if (target.accountId && delivery.accountId && target.accountId !== delivery.accountId) {
    return false;
  }
  return target.to === delivery.to;
}

function resolveCronDeliveryBestEffort(job: CronJob): boolean {
  if (typeof job.delivery?.bestEffort === "boolean") {
    return job.delivery.bestEffort;
  }
  if (job.payload.kind === "agentTurn" && typeof job.payload.bestEffortDeliver === "boolean") {
    return job.payload.bestEffortDeliver;
  }
  return false;
}

const CRON_SUBAGENT_WAIT_POLL_MS = 500;
const CRON_SUBAGENT_WAIT_MIN_MS = 30_000;
const CRON_SUBAGENT_FINAL_REPLY_GRACE_MS = 5_000;

function isLikelyInterimCronMessage(value: string): boolean {
  const text = value.trim();
  if (!text) {
    return true;
  }
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  const words = normalized.split(" ").filter(Boolean).length;
  const interimHints = [
    "on it",
    "pulling everything together",
    "give me a few",
    "give me a few min",
    "few minutes",
    "let me compile",
    "i'll gather",
    "i will gather",
    "working on it",
    "retrying now",
    "should be about",
    "should have your summary",
    "subagent spawned",
    "spawned a subagent",
    "it'll auto-announce when done",
    "it will auto-announce when done",
    "auto-announce when done",
    "both subagents are running",
    "wait for them to report back",
  ];
  return words <= 45 && interimHints.some((hint) => normalized.includes(hint));
}

function expectsSubagentFollowup(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) {
    return false;
  }
  const hints = [
    "subagent spawned",
    "spawned a subagent",
    "auto-announce when done",
    "both subagents are running",
    "wait for them to report back",
  ];
  return hints.some((hint) => normalized.includes(hint));
}

async function readDescendantSubagentFallbackReply(params: {
  sessionKey: string;
  runStartedAt: number;
}): Promise<string | undefined> {
  const descendants = listDescendantRunsForRequester(params.sessionKey)
    .filter(
      (entry) =>
        typeof entry.endedAt === "number" &&
        entry.endedAt >= params.runStartedAt &&
        entry.childSessionKey.trim().length > 0,
    )
    .toSorted((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  if (descendants.length === 0) {
    return undefined;
  }

  const latestByChild = new Map<string, (typeof descendants)[number]>();
  for (const entry of descendants) {
    const childKey = entry.childSessionKey.trim();
    if (!childKey) {
      continue;
    }
    const current = latestByChild.get(childKey);
    if (!current || (entry.endedAt ?? 0) >= (current.endedAt ?? 0)) {
      latestByChild.set(childKey, entry);
    }
  }

  const replies: string[] = [];
  const latestRuns = [...latestByChild.values()]
    .toSorted((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    .slice(-4);
  for (const entry of latestRuns) {
    const reply = (await readLatestAssistantReply({ sessionKey: entry.childSessionKey }))?.trim();
    if (!reply || reply.toUpperCase() === SILENT_REPLY_TOKEN.toUpperCase()) {
      continue;
    }
    replies.push(reply);
  }
  if (replies.length === 0) {
    return undefined;
  }
  if (replies.length === 1) {
    return replies[0];
  }
  return replies.join("\n\n");
}

async function waitForDescendantSubagentSummary(params: {
  sessionKey: string;
  initialReply?: string;
  timeoutMs: number;
  observedActiveDescendants?: boolean;
}): Promise<string | undefined> {
  const initialReply = params.initialReply?.trim();
  const deadline = Date.now() + Math.max(CRON_SUBAGENT_WAIT_MIN_MS, Math.floor(params.timeoutMs));
  let sawActiveDescendants = params.observedActiveDescendants === true;
  let drainedAtMs: number | undefined;
  while (Date.now() < deadline) {
    const activeDescendants = countActiveDescendantRuns(params.sessionKey);
    if (activeDescendants > 0) {
      sawActiveDescendants = true;
      drainedAtMs = undefined;
      await new Promise((resolve) => setTimeout(resolve, CRON_SUBAGENT_WAIT_POLL_MS));
      continue;
    }
    if (!sawActiveDescendants) {
      return initialReply;
    }
    if (!drainedAtMs) {
      drainedAtMs = Date.now();
    }
    const latest = (await readLatestAssistantReply({ sessionKey: params.sessionKey }))?.trim();
    if (
      latest &&
      latest.toUpperCase() !== SILENT_REPLY_TOKEN.toUpperCase() &&
      (latest !== initialReply || !isLikelyInterimCronMessage(latest))
    ) {
      return latest;
    }
    if (Date.now() - drainedAtMs >= CRON_SUBAGENT_FINAL_REPLY_GRACE_MS) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, CRON_SUBAGENT_WAIT_POLL_MS));
  }
  const latest = (await readLatestAssistantReply({ sessionKey: params.sessionKey }))?.trim();
  if (
    latest &&
    latest.toUpperCase() !== SILENT_REPLY_TOKEN.toUpperCase() &&
    (latest !== initialReply || !isLikelyInterimCronMessage(latest))
  ) {
    return latest;
  }
  return undefined;
}

export type RunCronAgentTurnResult = {
  status: "ok" | "error" | "skipped";
  summary?: string;
  /** Last non-empty agent text output (not truncated). */
  outputText?: string;
  error?: string;
  sessionId?: string;
  sessionKey?: string;
  /**
   * `true` when the isolated run already delivered its output to the target
   * channel (via outbound payloads, the subagent announce flow, or a matching
   * messaging-tool send). Callers should skip posting a summary to the main
   * session to avoid duplicate
   * messages.  See: https://github.com/openclaw/openclaw/issues/15692
   */
  delivered?: boolean;
};

export async function runCronIsolatedAgentTurn(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  message: string;
  sessionKey: string;
  agentId?: string;
  lane?: string;
}): Promise<RunCronAgentTurnResult> {
  const isFastTestEnv = process.env.OPENCLAW_TEST_FAST === "1";
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
  const { model: overrideModel, ...agentOverrideRest } = agentConfigOverride ?? {};
  // Use the requested agentId even when there is no explicit agent config entry.
  // This ensures auth-profiles, workspace, and agentDir all resolve to the
  // correct per-agent paths (e.g. ~/.openclaw/agents/<agentId>/agent/).
  const agentId = normalizedRequested ?? defaultAgentId;
  const agentCfg: AgentDefaultsConfig = Object.assign(
    {},
    params.cfg.agents?.defaults,
    agentOverrideRest as Partial<AgentDefaultsConfig>,
  );
  if (typeof overrideModel === "string") {
    agentCfg.model = { primary: overrideModel };
  } else if (overrideModel) {
    agentCfg.model = overrideModel;
  }
  const cfgWithAgentDefaults: OpenClawConfig = {
    ...params.cfg,
    agents: Object.assign({}, params.cfg.agents, { defaults: agentCfg }),
  };

  const baseSessionKey = (params.sessionKey?.trim() || `cron:${params.job.id}`).trim();
  const agentSessionKey = buildAgentMainSessionKey({
    agentId,
    mainKey: baseSessionKey,
  });

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
      return { status: "error", error: resolvedOverride.error };
    }
    provider = resolvedOverride.ref.provider;
    model = resolvedOverride.ref.model;
  }
  const now = Date.now();
  const cronSession = resolveCronSession({
    cfg: params.cfg,
    sessionKey: agentSessionKey,
    agentId,
    nowMs: now,
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

  // Resolve thinking level - job thinking > hooks.gmail.thinking > agent default
  const hooksGmailThinking = isGmailHook
    ? normalizeThinkLevel(params.cfg.hooks?.gmail?.thinking)
    : undefined;
  const thinkOverride = normalizeThinkLevel(agentCfg?.thinkingDefault);
  const jobThink = normalizeThinkLevel(
    (params.job.payload.kind === "agentTurn" ? params.job.payload.thinking : undefined) ??
      undefined,
  );
  let thinkLevel = jobThink ?? hooksGmailThinking ?? thinkOverride;
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
  const deliveryPlan = resolveCronDeliveryPlan(params.job);
  const deliveryRequested = deliveryPlan.requested;

  const resolvedDelivery = await resolveDeliveryTarget(cfgWithAgentDefaults, agentId, {
    channel: deliveryPlan.channel ?? "last",
    to: deliveryPlan.to,
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
  if (deliveryRequested) {
    commandBody =
      `${commandBody}\n\nReturn your summary as plain text; it will be delivered automatically. If the task explicitly calls for messaging a specific external recipient, note who/where it should go instead of sending it yourself.`.trim();
  }

let skillsSnapshot = cronSession.sessionEntry.skillsSnapshot;
  if (isFastTestEnv) {
    // Fast unit-test mode: avoid scanning the workspace and writing session stores.
    skillsSnapshot = skillsSnapshot ?? { prompt: "", skills: [] };
  } else {
    const existingSnapshot = cronSession.sessionEntry.skillsSnapshot;
    const skillsSnapshotVersion = getSkillsSnapshotVersion(workspaceDir);
    const needsSkillsSnapshot =
      !existingSnapshot || existingSnapshot.version !== skillsSnapshotVersion;
    const skillFilter = resolveAgentSkillsFilter(cfgWithAgentDefaults, agentId);
    if (needsSkillsSnapshot) {
      skillsSnapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
        config: cfgWithAgentDefaults,
        skillFilter,
        eligibility: { remote: getRemoteSkillEligibility() },
        snapshotVersion: skillsSnapshotVersion,
      });
      if (skillsSnapshot) {
        cronSession.sessionEntry = {
          ...cronSession.sessionEntry,
          updatedAt: Date.now(),
          skillsSnapshot,
        };
        await persistSessionEntry();
      }
    }
  }

  // Persist systemSent before the run, mirroring the inbound auto-reply behavior.
  cronSession.sessionEntry.systemSent = true;
  await persistSessionEntry();

  let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
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
    const fallbackResult = await runWithModelFallback({
      cfg: cfgWithAgentDefaults,
      provider,
      model,
      agentDir,
      fallbacksOverride: resolveAgentModelFallbacksOverride(params.cfg, agentId),
      run: (providerOverride, modelOverride) => {
        if (isCliProvider(providerOverride, cfgWithAgentDefaults)) {
          const cliSessionId = getCliSessionId(cronSession.sessionEntry, providerOverride);
          return runCliAgent({
            sessionId: cronSession.sessionEntry.sessionId,
            sessionKey: agentSessionKey,
            agentId,
            sessionFile,
            workspaceDir,
            config: cfgWithAgentDefaults,
            prompt: commandBody,
            provider: providerOverride,
            model: modelOverride,
            thinkLevel,
            timeoutMs,
            runId: cronSession.sessionEntry.sessionId,
            cliSessionId,
          });
        }
        return runEmbeddedPiAgent({
          sessionId: cronSession.sessionEntry.sessionId,
          sessionKey: agentSessionKey,
          agentId,
          messageChannel,
          agentAccountId: resolvedDelivery.accountId,
          sessionFile,
          workspaceDir,
          config: cfgWithAgentDefaults,
          skillsSnapshot,
          prompt: commandBody,
          lane: params.lane ?? "cron",
          provider: providerOverride,
          model: modelOverride,
          thinkLevel,
          verboseLevel: resolvedVerboseLevel,
          timeoutMs,
          runId: cronSession.sessionEntry.sessionId,
          requireExplicitMessageTarget: true,
          disableMessageTool: deliveryRequested,
        });
      },
    });
    runResult = fallbackResult.result;
    fallbackProvider = fallbackResult.provider;
    fallbackModel = fallbackResult.model;
    runEndedAt = Date.now();
  } catch (err) {
    return withRunSession({ status: "error", error: String(err) });
  }

  const payloads = runResult.payloads ?? [];

  // Update token+model fields in the session store.
  {
    const usage = runResult.meta.agentMeta?.usage;
    const promptTokens = runResult.meta.agentMeta?.promptTokens;
    const modelUsed = runResult.meta.agentMeta?.model ?? fallbackModel ?? model;
    const providerUsed = runResult.meta.agentMeta?.provider ?? fallbackProvider ?? provider;
    const contextTokens =
      agentCfg?.contextTokens ?? lookupContextTokens(modelUsed) ?? DEFAULT_CONTEXT_TOKENS;

    cronSession.sessionEntry.modelProvider = providerUsed;
    cronSession.sessionEntry.model = modelUsed;
    cronSession.sessionEntry.contextTokens = contextTokens;
    if (isCliProvider(providerUsed, cfgWithAgentDefaults)) {
      const cliSessionId = runResult.meta.agentMeta?.sessionId?.trim();
      if (cliSessionId) {
        setCliSessionId(cronSession.sessionEntry, providerUsed, cliSessionId);
      }
    }
    if (hasNonzeroUsage(usage)) {
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const totalTokens =
        deriveSessionTotalTokens({
          usage,
          contextTokens,
          promptTokens,
        }) ?? input;
      cronSession.sessionEntry.inputTokens = input;
      cronSession.sessionEntry.outputTokens = output;
      cronSession.sessionEntry.totalTokens = totalTokens;
      cronSession.sessionEntry.totalTokensFresh = true;
    }
    await persistSessionEntry();
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

  // Skip delivery for heartbeat-only responses (HEARTBEAT_OK with no real content).
  const ackMaxChars = resolveHeartbeatAckMaxChars(agentCfg);
  const skipHeartbeatDelivery = deliveryRequested && isHeartbeatOnlyResponse(payloads, ackMaxChars);
  const skipMessagingToolDelivery =
    deliveryRequested &&
    runResult.didSendViaMessagingTool === true &&
    (runResult.messagingToolSentTargets ?? []).some((target) =>
      matchesMessagingToolDeliveryTarget(target, {
        channel: resolvedDelivery.channel,
        to: resolvedDelivery.to,
        accountId: resolvedDelivery.accountId,
      }),
    );

  // `true` means we confirmed at least one outbound send reached the target.
  // Keep this strict so timer fallback can safely decide whether to wake main.
  let delivered = skipMessagingToolDelivery;
  if (deliveryRequested && !skipHeartbeatDelivery && !skipMessagingToolDelivery) {
    if (resolvedDelivery.error) {
      if (!deliveryBestEffort) {
        return withRunSession({
          status: "error",
          error: resolvedDelivery.error.message,
          summary,
          outputText,
        });
      }
      logWarn(`[cron:${params.job.id}] ${resolvedDelivery.error.message}`);
      return withRunSession({ status: "ok", summary, outputText });
    }
    if (!resolvedDelivery.to) {
      const message = "cron delivery target is missing";
      if (!deliveryBestEffort) {
        return withRunSession({
          status: "error",
          error: message,
          summary,
          outputText,
        });
      }
      logWarn(`[cron:${params.job.id}] ${message}`);
      return withRunSession({ status: "ok", summary, outputText });
    }
    const identity = resolveAgentOutboundIdentity(cfgWithAgentDefaults, agentId);

    // Shared subagent announce flow is text-based and prompts the main agent to
    // summarize. When we have an explicit delivery target (delivery.to), sender
    // identity, or structured content, prefer direct outbound delivery to send
    // the actual cron output without summarization.
    const hasExplicitDeliveryTarget = Boolean(deliveryPlan.to);
    if (deliveryPayloadHasStructuredContent || identity || hasExplicitDeliveryTarget) {
      try {
        const payloadsForDelivery =
          deliveryPayloadHasStructuredContent && deliveryPayloads.length > 0
            ? deliveryPayloads
            : synthesizedText
              ? [{ text: synthesizedText }]
              : [];
        if (payloadsForDelivery.length > 0) {
          const deliveryResults = await deliverOutboundPayloads({
            cfg: cfgWithAgentDefaults,
            channel: resolvedDelivery.channel,
            to: resolvedDelivery.to,
            accountId: resolvedDelivery.accountId,
            threadId: resolvedDelivery.threadId,
            payloads: payloadsForDelivery,
            agentId,
            identity,
            bestEffort: deliveryBestEffort,
            deps: createOutboundSendDeps(params.deps),
          });
          delivered = deliveryResults.length > 0;
        }
      } catch (err) {
        if (!deliveryBestEffort) {
          return withRunSession({ status: "error", summary, outputText, error: String(err) });
        }
      }
    } else if (synthesizedText) {
      const announceSessionKey = resolveAgentMainSessionKey({
        cfg: params.cfg,
        agentId,
      });
      const taskLabel =
        typeof params.job.name === "string" && params.job.name.trim()
          ? params.job.name.trim()
          : `cron:${params.job.id}`;
      const initialSynthesizedText = synthesizedText.trim();
      let activeSubagentRuns = countActiveDescendantRuns(agentSessionKey);
      const expectedSubagentFollowup = expectsSubagentFollowup(initialSynthesizedText);
      const hadActiveDescendants = activeSubagentRuns > 0;
      if (activeSubagentRuns > 0 || expectedSubagentFollowup) {
        let finalReply = await waitForDescendantSubagentSummary({
          sessionKey: agentSessionKey,
          initialReply: initialSynthesizedText,
          timeoutMs,
          observedActiveDescendants: activeSubagentRuns > 0 || expectedSubagentFollowup,
        });
        activeSubagentRuns = countActiveDescendantRuns(agentSessionKey);
        if (
          !finalReply &&
          activeSubagentRuns === 0 &&
          (hadActiveDescendants || expectedSubagentFollowup)
        ) {
          finalReply = await readDescendantSubagentFallbackReply({
            sessionKey: agentSessionKey,
            runStartedAt,
          });
        }
        if (finalReply && activeSubagentRuns === 0) {
          outputText = finalReply;
          summary = pickSummaryFromOutput(finalReply) ?? summary;
          synthesizedText = finalReply;
          deliveryPayloads = [{ text: finalReply }];
        }
      }
      if (activeSubagentRuns > 0) {
        // Parent orchestration is still in progress; avoid announcing a partial
        // update to the main requester.
        return withRunSession({ status: "ok", summary, outputText });
      }
      if (
        (hadActiveDescendants || expectedSubagentFollowup) &&
        synthesizedText.trim() === initialSynthesizedText &&
        isLikelyInterimCronMessage(initialSynthesizedText) &&
        initialSynthesizedText.toUpperCase() !== SILENT_REPLY_TOKEN.toUpperCase()
      ) {
        // Descendants existed but no post-orchestration synthesis arrived, so
        // suppress stale parent text like "on it, pulling everything together".
        return withRunSession({ status: "ok", summary, outputText });
      }
      if (synthesizedText.toUpperCase() === SILENT_REPLY_TOKEN.toUpperCase()) {
        return withRunSession({ status: "ok", summary, outputText });
      }
      try {
        const didAnnounce = await runSubagentAnnounceFlow({
          childSessionKey: agentSessionKey,
          childRunId: `${params.job.id}:${runSessionId}`,
          requesterSessionKey: announceSessionKey,
          requesterOrigin: {
            channel: resolvedDelivery.channel,
            to: resolvedDelivery.to,
            accountId: resolvedDelivery.accountId,
            threadId: resolvedDelivery.threadId,
          },
          requesterDisplayKey: announceSessionKey,
          task: taskLabel,
          timeoutMs,
          cleanup: params.job.deleteAfterRun ? "delete" : "keep",
          roundOneReply: synthesizedText,
          waitForCompletion: false,
          startedAt: runStartedAt,
          endedAt: runEndedAt,
          outcome: { status: "ok" },
          announceType: "cron job",
        });
        if (didAnnounce) {
          delivered = true;
        } else {
          const message = "cron announce delivery failed";
          if (!deliveryBestEffort) {
            return withRunSession({
              status: "error",
              summary,
              outputText,
              error: message,
            });
          }
          logWarn(`[cron:${params.job.id}] ${message}`);
        }
      } catch (err) {
        if (!deliveryBestEffort) {
          return withRunSession({ status: "error", summary, outputText, error: String(err) });
        }
        logWarn(`[cron:${params.job.id}] ${String(err)}`);
      }
    }
  }

  return withRunSession({ status: "ok", summary, outputText, delivered });
}
