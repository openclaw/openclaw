import fs from "node:fs";
import path from "node:path";
import type { MessagingToolSend } from "../../agents/pi-embedded-messaging.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { AgentDefaultsConfig } from "../../config/types.js";
import type { ExecutionRequest, ExecutionResult } from "../../execution/types.js";
import type { CronJob } from "../types.js";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { setCliSessionId } from "../../agents/cli-session.js";
import { lookupContextTokens } from "../../agents/context.js";
import {
  formatUserTime,
  resolveUserTimeFormat,
  resolveUserTimezone,
} from "../../agents/date-time.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveSessionRuntimeKind } from "../../agents/main-agent-runtime-factory.js";
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
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { hasNonzeroUsage } from "../../agents/usage.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import { isHeartbeatContentEffectivelyEmpty } from "../../auto-reply/heartbeat.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  supportsXHighThinking,
} from "../../auto-reply/thinking.js";
import { createOutboundSendDeps, type CliDeps } from "../../cli/outbound-send-deps.js";
import { resolveSessionTranscriptPath, updateSessionStore } from "../../config/sessions.js";
import { createDefaultExecutionKernel } from "../../execution/kernel.js";
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
  pickLastNonEmptyTextFromPayloads,
  pickSummaryFromOutput,
  pickSummaryFromPayloads,
  resolveHeartbeatAckMaxChars,
} from "./helpers.js";
import { resolveCronSession } from "./session.js";

function fileEndsWithNewline(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) {
      return true;
    }
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(1);
      fs.readSync(fd, buffer, 0, 1, stat.size - 1);
      return buffer[0] === 0x0a;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return true;
  }
}

function appendSessionTranscriptMessage(params: {
  sessionFile: string;
  role: "assistant" | "user";
  text: string;
  timestamp?: number;
}): void {
  const trimmed = params.text.trim();
  if (!trimmed) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(params.sessionFile), { recursive: true });
    const prefix =
      fs.existsSync(params.sessionFile) && !fileEndsWithNewline(params.sessionFile) ? "\n" : "";
    fs.appendFileSync(
      params.sessionFile,
      `${prefix}${JSON.stringify({
        message: {
          role: params.role,
          content: [{ type: "text", text: trimmed }],
          timestamp: params.timestamp ?? Date.now(),
        },
      })}\n`,
      "utf-8",
    );
  } catch (err) {
    logWarn(`[cron] Failed to append transcript note: ${String(err)}`);
  }
}

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
  const agentId = agentConfigOverride ? (normalizedRequested ?? defaultAgentId) : defaultAgentId;
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
  const now = Date.now();
  const cronSession = resolveCronSession({
    cfg: params.cfg,
    sessionKey: agentSessionKey,
    agentId,
    nowMs: now,
  });

  // Avoid creating "empty" heartbeat sessions when HEARTBEAT.md exists but has no tasks.
  // A missing file is not skipped (the model may still decide what to do).
  const isHeartbeatPrompt =
    typeof params.message === "string" &&
    params.message.trim().toLowerCase().startsWith("read heartbeat.md");
  if (isHeartbeatPrompt) {
    const heartbeatPath = path.join(workspaceDir, "HEARTBEAT.md");
    if (fs.existsSync(heartbeatPath)) {
      try {
        const content = fs.readFileSync(heartbeatPath, "utf-8");
        if (isHeartbeatContentEffectivelyEmpty(content)) {
          appendSessionTranscriptMessage({
            sessionFile: resolveSessionTranscriptPath(cronSession.sessionEntry.sessionId, agentId),
            role: "assistant",
            text: "Cron skipped: HEARTBEAT.md is empty.",
            timestamp: now,
          });
          return { status: "skipped", summary: "Heartbeat skipped (HEARTBEAT.md is empty)." };
        }
      } catch (err) {
        logWarn(`Failed to read HEARTBEAT.md for emptiness check: ${String(err)}`);
      }
    }
  }

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
  if (modelOverrideRaw !== undefined) {
    if (typeof modelOverrideRaw !== "string") {
      return { status: "error", error: "invalid model: expected string" };
    }
    const resolvedOverride = resolveAllowedModelRef({
      cfg: cfgWithAgentDefaults,
      catalog: await loadCatalog(),
      raw: modelOverrideRaw,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if ("error" in resolvedOverride) {
      return { status: "error", error: resolvedOverride.error };
    }
    provider = resolvedOverride.ref.provider;
    model = resolvedOverride.ref.model;
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

  const userTimezone = resolveUserTimezone(params.cfg.agents?.defaults?.userTimezone);
  const userTimeFormat = resolveUserTimeFormat(params.cfg.agents?.defaults?.timeFormat);
  const formattedTime =
    formatUserTime(new Date(now), userTimezone, userTimeFormat) ?? new Date(now).toISOString();
  const timeLine = `Current time: ${formattedTime} (${userTimezone})`;
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
    cronSession.store[agentSessionKey] = cronSession.sessionEntry;
    await updateSessionStore(cronSession.storePath, (store) => {
      store[agentSessionKey] = cronSession.sessionEntry;
    });
  }

  // Persist systemSent before the run, mirroring the inbound auto-reply behavior.
  cronSession.sessionEntry.systemSent = true;
  cronSession.store[agentSessionKey] = cronSession.sessionEntry;
  await updateSessionStore(cronSession.storePath, (store) => {
    store[agentSessionKey] = cronSession.sessionEntry;
  });

  let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
  let fallbackProvider = provider;
  let fallbackModel = model;
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
    // Resolve runtime kind before runWithModelFallback so auth filtering is aware of claude SDK
    const runtimeKind = resolveSessionRuntimeKind(cfgWithAgentDefaults, agentId, agentSessionKey);

    const kernel = createDefaultExecutionKernel();
    const fallbackResult = await runWithModelFallback({
      cfg: cfgWithAgentDefaults,
      provider,
      model,
      agentDir,
      fallbacksOverride: resolveAgentModelFallbacksOverride(params.cfg, agentId),
      runtimeKind,
      run: async (providerOverride, modelOverride) => {
        const request: ExecutionRequest = {
          agentId,
          sessionId: cronSession.sessionEntry.sessionId,
          sessionKey: agentSessionKey,
          runId: cronSession.sessionEntry.sessionId,
          workspaceDir,
          agentDir,
          config: cfgWithAgentDefaults,
          prompt: commandBody,
          timeoutMs,
          sessionFile,
          providerOverride,
          modelOverride,
          messageContext: {
            provider: messageChannel,
            accountId: resolvedDelivery.accountId,
          },
          runtimeHints: {
            thinkLevel,
            verboseLevel: resolvedVerboseLevel,
            skillsSnapshot,
            lane: params.lane ?? "cron",
            requireExplicitMessageTarget: true,
            disableMessageTool: deliveryRequested,
          },
        };
        const execResult = await kernel.execute(request);
        return mapCronExecutionResultToLegacy(execResult);
      },
    });
    runResult = fallbackResult.result;
    fallbackProvider = fallbackResult.provider;
    fallbackModel = fallbackResult.model;
  } catch (err) {
    return { status: "error", error: String(err) };
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
    // Persist Claude SDK session ID for native session resume on next cron run.
    const returnedClaudeSdkSessionId = runResult.meta.agentMeta?.claudeSessionId?.trim();
    if (returnedClaudeSdkSessionId) {
      cronSession.sessionEntry.claudeSdkSessionId = returnedClaudeSdkSessionId;
    }
    if (hasNonzeroUsage(usage)) {
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const promptTokens = input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      cronSession.sessionEntry.inputTokens = input;
      cronSession.sessionEntry.outputTokens = output;
      cronSession.sessionEntry.totalTokens =
        promptTokens > 0 ? promptTokens : (usage.total ?? input);
    }
    cronSession.store[agentSessionKey] = cronSession.sessionEntry;
    await updateSessionStore(cronSession.storePath, (store) => {
      store[agentSessionKey] = cronSession.sessionEntry;
    });
  }
  const firstText = payloads[0]?.text ?? "";
  const summary = pickSummaryFromPayloads(payloads) ?? pickSummaryFromOutput(firstText);
  const outputText = pickLastNonEmptyTextFromPayloads(payloads);
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
        return {
          status: "error",
          error: resolvedDelivery.error.message,
          summary,
          outputText,
        };
      }
      logWarn(`[cron:${params.job.id}] ${resolvedDelivery.error.message}`);
      return { status: "ok", summary, outputText };
    }
    if (!resolvedDelivery.to) {
      const message = "cron delivery target is missing";
      if (!deliveryBestEffort) {
        return {
          status: "error",
          error: message,
          summary,
          outputText,
        };
      }
      logWarn(`[cron:${params.job.id}] ${message}`);
      return { status: "ok", summary, outputText };
    }
    try {
      await deliverOutboundPayloads({
        cfg: cfgWithAgentDefaults,
        channel: resolvedDelivery.channel,
        to: resolvedDelivery.to,
        accountId: resolvedDelivery.accountId,
        threadId: resolvedDelivery.threadId,
        payloads,
        bestEffort: deliveryBestEffort,
        deps: createOutboundSendDeps(params.deps),
      });
    } catch (err) {
      if (!deliveryBestEffort) {
        return { status: "error", summary, outputText, error: String(err) };
      }
    }
  }

  return { status: "ok", summary, outputText };
}

/**
 * Map ExecutionResult to the legacy EmbeddedPiRunResult format used by cron post-processing.
 */
function mapCronExecutionResultToLegacy(
  result: ExecutionResult,
): Awaited<ReturnType<typeof runEmbeddedPiAgent>> {
  return {
    payloads: result.payloads.map((p) => ({
      text: p.text,
      mediaUrl: p.mediaUrl,
      mediaUrls: p.mediaUrls,
      replyToId: p.replyToId,
      isError: p.isError,
    })),
    meta: {
      durationMs: result.usage.durationMs,
      aborted: result.aborted,
      agentMeta: {
        sessionId: "",
        provider: result.runtime.provider ?? "",
        model: result.runtime.model ?? "",
        claudeSessionId: result.claudeSdkSessionId,
        usage: {
          input: result.usage.inputTokens,
          output: result.usage.outputTokens,
          cacheRead: result.usage.cacheReadTokens,
          cacheWrite: result.usage.cacheWriteTokens,
          total: result.usage.inputTokens + result.usage.outputTokens,
        },
      },
      systemPromptReport: result.systemPromptReport as Awaited<
        ReturnType<typeof runEmbeddedPiAgent>
      >["meta"]["systemPromptReport"],
      error: result.embeddedError
        ? {
            kind: result.embeddedError.kind as
              | "context_overflow"
              | "compaction_failure"
              | "role_ordering"
              | "image_size",
            message: result.embeddedError.message,
          }
        : undefined,
    },
    didSendViaMessagingTool: result.didSendViaMessagingTool,
    messagingToolSentTexts: result.messagingToolSentTexts,
    messagingToolSentTargets: result.messagingToolSentTargets as Awaited<
      ReturnType<typeof runEmbeddedPiAgent>
    >["messagingToolSentTargets"],
  };
}
