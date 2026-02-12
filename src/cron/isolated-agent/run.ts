import type { MessagingToolSend } from "../../agents/pi-embedded-messaging.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { AgentDefaultsConfig } from "../../config/types.js";
import type { CronJob } from "../types.js";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentModelFallbacksOverride,
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
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../../agents/usage.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  supportsXHighThinking,
} from "../../auto-reply/thinking.js";
import { createOutboundSendDeps, type CliDeps } from "../../cli/outbound-send-deps.js";
import {
  resolveAgentMainSessionKey,
  resolveSessionTranscriptPath,
  updateSessionStore,
} from "../../config/sessions.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
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

export type RunCronAgentTurnResult = {
  status: "ok" | "error" | "skipped";
  summary?: string;
  /** Last non-empty agent text output (not truncated). */
  outputText?: string;
  error?: string;
  sessionId?: string;
  sessionKey?: string;
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
    ensureBootstrapFiles: !agentCfg?.skipBootstrap,
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

  const existingSnapshot = cronSession.sessionEntry.skillsSnapshot;
  const skillsSnapshotVersion = getSkillsSnapshotVersion(workspaceDir);
  const needsSkillsSnapshot =
    !existingSnapshot || existingSnapshot.version !== skillsSnapshotVersion;
  const skillsSnapshot = needsSkillsSnapshot
    ? buildWorkspaceSkillSnapshot(workspaceDir, {
        config: cfgWithAgentDefaults,
        eligibility: { remote: getRemoteSkillEligibility() },
        snapshotVersion: skillsSnapshotVersion,
      })
    : cronSession.sessionEntry.skillsSnapshot;
  if (needsSkillsSnapshot && skillsSnapshot) {
    cronSession.sessionEntry = {
      ...cronSession.sessionEntry,
      updatedAt: Date.now(),
      skillsSnapshot,
    };
    await persistSessionEntry();
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
      cronSession.sessionEntry.inputTokens = input;
      cronSession.sessionEntry.outputTokens = output;
      cronSession.sessionEntry.totalTokens =
        deriveSessionTotalTokens({
          usage,
          contextTokens,
        }) ?? input;
    }
    await persistSessionEntry();
  }
  const firstText = payloads[0]?.text ?? "";
  const summary = pickSummaryFromPayloads(payloads) ?? pickSummaryFromOutput(firstText);
  const outputText = pickLastNonEmptyTextFromPayloads(payloads);
  const synthesizedText = outputText?.trim() || summary?.trim() || undefined;
  const deliveryPayload = pickLastDeliverablePayload(payloads);
  const deliveryPayloads =
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
    // Shared subagent announce flow is text-based; keep direct outbound delivery
    // for media/channel payloads so structured content is preserved.
    if (deliveryPayloadHasStructuredContent) {
      try {
        await deliverOutboundPayloads({
          cfg: cfgWithAgentDefaults,
          channel: resolvedDelivery.channel,
          to: resolvedDelivery.to,
          accountId: resolvedDelivery.accountId,
          threadId: resolvedDelivery.threadId,
          payloads: deliveryPayloads,
          bestEffort: deliveryBestEffort,
          deps: createOutboundSendDeps(params.deps),
        });
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
      try {
        const didAnnounce = await runSubagentAnnounceFlow({
          childSessionKey: runSessionKey,
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
          cleanup: "keep",
          roundOneReply: synthesizedText,
          waitForCompletion: false,
          startedAt: runStartedAt,
          endedAt: runEndedAt,
          outcome: { status: "ok" },
          announceType: "cron job",
        });
        if (!didAnnounce) {
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

  return withRunSession({ status: "ok", summary, outputText });
}
