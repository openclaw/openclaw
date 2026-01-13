import crypto from "node:crypto";
import {
  resolveAgentConfig,
  resolveAgentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { runCliAgent } from "../agents/cli-runner.js";
import { getCliSessionId, setCliSessionId } from "../agents/cli-session.js";
import { lookupContextTokens } from "../agents/context.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runWithModelFallback } from "../agents/model-fallback.js";
import {
  getModelRefStatus,
  isCliProvider,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
  resolveThinkingDefault,
} from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { buildWorkspaceSkillSnapshot } from "../agents/skills.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import { hasNonzeroUsage } from "../agents/usage.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  stripHeartbeatToken,
} from "../auto-reply/heartbeat.js";
import {
  formatXHighModelHint,
  normalizeThinkLevel,
  supportsXHighThinking,
} from "../auto-reply/thinking.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.js";
import { DEFAULT_CHAT_CHANNEL } from "../channels/registry.js";
import type { CliDeps } from "../cli/deps.js";
import type { ClawdbotConfig } from "../config/config.js";
import {
  DEFAULT_IDLE_MINUTES,
  loadSessionStore,
  resolveAgentMainSessionKey,
  resolveSessionTranscriptPath,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../config/sessions.js";
import type { AgentDefaultsConfig } from "../config/types.js";
import { registerAgentRunContext } from "../infra/agent-events.js";
import { resolveMessageChannelSelection } from "../infra/outbound/channel-selection.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import type { OutboundChannel } from "../infra/outbound/targets.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
} from "../routing/session-key.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import { truncateUtf16Safe } from "../utils.js";
import type { CronJob } from "./types.js";

export type RunCronAgentTurnResult = {
  status: "ok" | "error" | "skipped";
  summary?: string;
  error?: string;
};

type DeliveryPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
};

function pickSummaryFromOutput(text: string | undefined) {
  const clean = (text ?? "").trim();
  if (!clean) return undefined;
  const limit = 2000;
  return clean.length > limit ? `${truncateUtf16Safe(clean, limit)}…` : clean;
}

function pickSummaryFromPayloads(
  payloads: Array<{ text?: string | undefined }>,
) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    const summary = pickSummaryFromOutput(payloads[i]?.text);
    if (summary) return summary;
  }
  return undefined;
}

/**
 * Check if all payloads are just heartbeat ack responses (HEARTBEAT_OK).
 * Returns true if delivery should be skipped because there's no real content.
 */
function isHeartbeatOnlyResponse(
  payloads: DeliveryPayload[],
  ackMaxChars: number,
) {
  if (payloads.length === 0) return true;
  return payloads.every((payload) => {
    // If there's media, we should deliver regardless of text content.
    const hasMedia =
      (payload.mediaUrls?.length ?? 0) > 0 || Boolean(payload.mediaUrl);
    if (hasMedia) return false;
    // Use heartbeat mode to check if text is just HEARTBEAT_OK or short ack.
    const result = stripHeartbeatToken(payload.text, {
      mode: "heartbeat",
      maxAckChars: ackMaxChars,
    });
    return result.shouldSkip;
  });
}

async function resolveDeliveryTarget(
  cfg: ClawdbotConfig,
  agentId: string,
  jobPayload: {
    channel?: "last" | ChannelId;
    to?: string;
  },
): Promise<{
  channel: Exclude<OutboundChannel, "none">;
  to?: string;
  accountId?: string;
  mode: "explicit" | "implicit";
  error?: Error;
}> {
  const requestedRaw =
    typeof jobPayload.channel === "string" ? jobPayload.channel : "last";
  const requestedChannelHint =
    normalizeMessageChannel(requestedRaw) ?? requestedRaw;
  const explicitTo =
    typeof jobPayload.to === "string" && jobPayload.to.trim()
      ? jobPayload.to.trim()
      : undefined;

  const sessionCfg = cfg.session;
  const mainSessionKey = resolveAgentMainSessionKey({ cfg, agentId });
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const store = loadSessionStore(storePath);
  const main = store[mainSessionKey];
  const lastChannel =
    main?.lastChannel && main.lastChannel !== INTERNAL_MESSAGE_CHANNEL
      ? normalizeChannelId(main.lastChannel)
      : undefined;
  const lastTo = typeof main?.lastTo === "string" ? main.lastTo.trim() : "";
  const lastAccountId = main?.lastAccountId;

  let channel: Exclude<OutboundChannel, "none"> | undefined =
    requestedChannelHint === "last"
      ? (lastChannel ?? undefined)
      : requestedChannelHint === INTERNAL_MESSAGE_CHANNEL
        ? undefined
        : (normalizeChannelId(requestedChannelHint) ?? undefined);
  if (!channel) {
    try {
      const selection = await resolveMessageChannelSelection({ cfg });
      channel = selection.channel;
    } catch {
      channel = lastChannel ?? DEFAULT_CHAT_CHANNEL;
    }
  }

  const toCandidate = explicitTo ?? (lastTo || undefined);
  const mode: "explicit" | "implicit" = explicitTo ? "explicit" : "implicit";
  if (!toCandidate) {
    return { channel, to: undefined, accountId: lastAccountId, mode };
  }

  const resolved = resolveOutboundTarget({
    channel,
    to: toCandidate,
    cfg,
    accountId: channel === lastChannel ? lastAccountId : undefined,
    mode,
  });
  return {
    channel,
    to: resolved.ok ? resolved.to : undefined,
    accountId: channel === lastChannel ? lastAccountId : undefined,
    mode,
    error: resolved.ok ? undefined : resolved.error,
  };
}

function resolveCronSession(params: {
  cfg: ClawdbotConfig;
  sessionKey: string;
  nowMs: number;
  agentId: string;
}) {
  const sessionCfg = params.cfg.session;
  const idleMinutes = Math.max(
    sessionCfg?.idleMinutes ?? DEFAULT_IDLE_MINUTES,
    1,
  );
  const idleMs = idleMinutes * 60_000;
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];
  const fresh = entry && params.nowMs - entry.updatedAt <= idleMs;
  const sessionId = fresh ? entry.sessionId : crypto.randomUUID();
  const systemSent = fresh ? Boolean(entry.systemSent) : false;
  const sessionEntry: SessionEntry = {
    sessionId,
    updatedAt: params.nowMs,
    systemSent,
    thinkingLevel: entry?.thinkingLevel,
    verboseLevel: entry?.verboseLevel,
    model: entry?.model,
    contextTokens: entry?.contextTokens,
    sendPolicy: entry?.sendPolicy,
    lastChannel: entry?.lastChannel,
    lastTo: entry?.lastTo,
  };
  return { storePath, store, sessionEntry, systemSent, isNewSession: !fresh };
}

export async function runCronIsolatedAgentTurn(params: {
  cfg: ClawdbotConfig;
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
  const normalizedRequested = requestedAgentId
    ? normalizeAgentId(requestedAgentId)
    : undefined;
  const agentConfigOverride = normalizedRequested
    ? resolveAgentConfig(params.cfg, normalizedRequested)
    : undefined;
  const { model: overrideModel, ...agentOverrideRest } =
    agentConfigOverride ?? {};
  const agentId = agentConfigOverride
    ? (normalizedRequested ?? defaultAgentId)
    : defaultAgentId;
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
  const cfgWithAgentDefaults: ClawdbotConfig = {
    ...params.cfg,
    agents: Object.assign({}, params.cfg.agents, { defaults: agentCfg }),
  };

  const baseSessionKey = (
    params.sessionKey?.trim() || `cron:${params.job.id}`
  ).trim();
  const agentSessionKey = buildAgentMainSessionKey({
    agentId,
    mainKey: baseSessionKey,
  });

  const workspaceDirRaw = resolveAgentWorkspaceDir(params.cfg, agentId);
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
    params.job.payload.kind === "agentTurn"
      ? params.job.payload.model
      : undefined;
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
  const now = Date.now();
  const cronSession = resolveCronSession({
    cfg: params.cfg,
    sessionKey: agentSessionKey,
    agentId,
    nowMs: now,
  });
  const isFirstTurnInSession =
    cronSession.isNewSession || !cronSession.systemSent;

  // Resolve thinking level - job thinking > hooks.gmail.thinking > agent default
  const hooksGmailThinking = isGmailHook
    ? normalizeThinkLevel(params.cfg.hooks?.gmail?.thinking)
    : undefined;
  const thinkOverride = normalizeThinkLevel(agentCfg?.thinkingDefault);
  const jobThink = normalizeThinkLevel(
    (params.job.payload.kind === "agentTurn"
      ? params.job.payload.thinking
      : undefined) ?? undefined,
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
    throw new Error(
      `Thinking level "xhigh" is only supported for ${formatXHighModelHint()}.`,
    );
  }

  const timeoutMs = resolveAgentTimeoutMs({
    cfg: cfgWithAgentDefaults,
    overrideSeconds:
      params.job.payload.kind === "agentTurn"
        ? params.job.payload.timeoutSeconds
        : undefined,
  });

  const delivery =
    params.job.payload.kind === "agentTurn" &&
    params.job.payload.deliver === true;
  const bestEffortDeliver =
    params.job.payload.kind === "agentTurn" &&
    params.job.payload.bestEffortDeliver === true;

  const resolvedDelivery = await resolveDeliveryTarget(
    cfgWithAgentDefaults,
    agentId,
    {
      channel:
        params.job.payload.kind === "agentTurn"
          ? (params.job.payload.channel ?? "last")
          : "last",
      to:
        params.job.payload.kind === "agentTurn"
          ? params.job.payload.to
          : undefined,
    },
  );

  const base =
    `[cron:${params.job.id} ${params.job.name}] ${params.message}`.trim();

  const commandBody = base;

  const needsSkillsSnapshot =
    cronSession.isNewSession || !cronSession.sessionEntry.skillsSnapshot;
  const skillsSnapshot = needsSkillsSnapshot
    ? buildWorkspaceSkillSnapshot(workspaceDir, {
        config: cfgWithAgentDefaults,
      })
    : cronSession.sessionEntry.skillsSnapshot;
  if (needsSkillsSnapshot && skillsSnapshot) {
    cronSession.sessionEntry = {
      ...cronSession.sessionEntry,
      updatedAt: Date.now(),
      skillsSnapshot,
    };
    cronSession.store[agentSessionKey] = cronSession.sessionEntry;
    await saveSessionStore(cronSession.storePath, cronSession.store);
  }

  // Persist systemSent before the run, mirroring the inbound auto-reply behavior.
  if (isFirstTurnInSession) {
    cronSession.sessionEntry.systemSent = true;
    cronSession.store[agentSessionKey] = cronSession.sessionEntry;
    await saveSessionStore(cronSession.storePath, cronSession.store);
  } else {
    cronSession.store[agentSessionKey] = cronSession.sessionEntry;
    await saveSessionStore(cronSession.storePath, cronSession.store);
  }

  let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
  let fallbackProvider = provider;
  let fallbackModel = model;
  try {
    const sessionFile = resolveSessionTranscriptPath(
      cronSession.sessionEntry.sessionId,
      agentId,
    );
    const resolvedVerboseLevel =
      (cronSession.sessionEntry.verboseLevel as "on" | "off" | undefined) ??
      (agentCfg?.verboseDefault as "on" | "off" | undefined);
    registerAgentRunContext(cronSession.sessionEntry.sessionId, {
      sessionKey: agentSessionKey,
      verboseLevel: resolvedVerboseLevel,
    });
    const messageChannel = resolvedDelivery.channel;
    const fallbackResult = await runWithModelFallback({
      cfg: cfgWithAgentDefaults,
      provider,
      model,
      fallbacksOverride: resolveAgentModelFallbacksOverride(
        params.cfg,
        agentId,
      ),
      run: (providerOverride, modelOverride) => {
        if (isCliProvider(providerOverride, cfgWithAgentDefaults)) {
          const cliSessionId = getCliSessionId(
            cronSession.sessionEntry,
            providerOverride,
          );
          return runCliAgent({
            sessionId: cronSession.sessionEntry.sessionId,
            sessionKey: agentSessionKey,
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
          messageChannel,
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
        });
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
    const providerUsed =
      runResult.meta.agentMeta?.provider ?? fallbackProvider ?? provider;
    const contextTokens =
      agentCfg?.contextTokens ??
      lookupContextTokens(modelUsed) ??
      DEFAULT_CONTEXT_TOKENS;

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
      const promptTokens =
        input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      cronSession.sessionEntry.inputTokens = input;
      cronSession.sessionEntry.outputTokens = output;
      cronSession.sessionEntry.totalTokens =
        promptTokens > 0 ? promptTokens : (usage.total ?? input);
    }
    cronSession.store[agentSessionKey] = cronSession.sessionEntry;
    await saveSessionStore(cronSession.storePath, cronSession.store);
  }
  const firstText = payloads[0]?.text ?? "";
  const summary =
    pickSummaryFromPayloads(payloads) ?? pickSummaryFromOutput(firstText);

  // Skip delivery for heartbeat-only responses (HEARTBEAT_OK with no real content).
  // This allows cron jobs to silently ack when nothing to report but still deliver
  // actual content when there is something to say.
  const ackMaxChars =
    agentCfg?.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
  const skipHeartbeatDelivery =
    delivery && isHeartbeatOnlyResponse(payloads, Math.max(0, ackMaxChars));

  if (delivery && !skipHeartbeatDelivery) {
    if (!resolvedDelivery.to) {
      const reason =
        resolvedDelivery.error?.message ??
        "Cron delivery requires a recipient (--to).";
      if (!bestEffortDeliver) {
        return {
          status: "error",
          summary,
          error: reason,
        };
      }
      return {
        status: "skipped",
        summary: `Delivery skipped (${reason}).`,
      };
    }
    try {
      await deliverOutboundPayloads({
        cfg: cfgWithAgentDefaults,
        channel: resolvedDelivery.channel,
        to: resolvedDelivery.to,
        accountId: resolvedDelivery.accountId,
        payloads,
        bestEffort: bestEffortDeliver,
        deps: {
          sendWhatsApp: params.deps.sendMessageWhatsApp,
          sendTelegram: params.deps.sendMessageTelegram,
          sendDiscord: params.deps.sendMessageDiscord,
          sendSlack: params.deps.sendMessageSlack,
          sendSignal: params.deps.sendMessageSignal,
          sendIMessage: params.deps.sendMessageIMessage,
          sendMSTeams: params.deps.sendMessageMSTeams
            ? async (to, text, opts) =>
                await params.deps.sendMessageMSTeams({
                  cfg: params.cfg,
                  to,
                  text,
                  mediaUrl: opts?.mediaUrl,
                })
            : undefined,
        },
      });
    } catch (err) {
      if (!bestEffortDeliver) {
        return { status: "error", summary, error: String(err) };
      }
      return { status: "ok", summary };
    }
  }

  return { status: "ok", summary };
}
