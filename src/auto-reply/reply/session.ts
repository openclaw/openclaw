import crypto from "node:crypto";
import path from "node:path";
import {
  buildTelegramTopicConversationId,
  parseTelegramChatIdFromTarget,
} from "../../acp/conversation-id.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  DEFAULT_RESET_TRIGGERS,
  deriveSessionMetaPatch,
  evaluateSessionFreshness,
  type GroupKeyResolution,
  loadSessionStore,
  resolveAndPersistSessionFile,
  resolveChannelResetConfig,
  resolveThreadFlag,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveGroupSessionKey,
  resolveSessionKey,
  resolveSessionTranscriptPath,
  resolveStorePath,
  type SessionEntry,
  type SessionScope,
  updateSessionStore,
} from "../../config/sessions.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { archiveSessionTranscripts } from "../../gateway/session-utils.fs.js";
import { resolveConversationIdFromTargets } from "../../infra/outbound/conversation-id.js";
import { deliverSessionMaintenanceWarning } from "../../infra/session-maintenance-warning.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { cleanupSessionSanitizationArtifacts } from "../../memory/session-sanitization/service.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { normalizeMainKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { resolveEffectiveResetTargetSessionKey } from "./acp-reset-target.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import {
  maybeRetireLegacyMainDeliveryRoute,
  resolveLastChannelRaw,
  resolveLastToRaw,
} from "./session-delivery.js";
import { forkSessionFromParent, resolveParentForkMaxTokens } from "./session-fork.js";
import { buildSessionEndHookPayload, buildSessionStartHookPayload } from "./session-hooks.js";

const log = createSubsystemLogger("session-init");

export type SessionInitResult = {
  sessionCtx: TemplateContext;
  sessionEntry: SessionEntry;
  previousSessionEntry?: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  sessionId: string;
  isNewSession: boolean;
  resetTriggered: boolean;
  systemSent: boolean;
  abortedLastRun: boolean;
  storePath: string;
  sessionScope: SessionScope;
  groupResolution?: GroupKeyResolution;
  isGroup: boolean;
  bodyStripped?: string;
  triggerBodyNormalized: string;
};

function normalizeSessionText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return `${value}`.trim();
  }
  return "";
}

function parseDiscordParentChannelFromSessionKey(raw: unknown): string | undefined {
  const sessionKey = normalizeSessionText(raw);
  if (!sessionKey) {
    return undefined;
  }
  const scoped = parseAgentSessionKey(sessionKey)?.rest ?? sessionKey.toLowerCase();
  const match = scoped.match(/(?:^|:)channel:([^:]+)$/);
  if (!match?.[1]) {
    return undefined;
  }
  return match[1];
}

function resolveAcpResetBindingContext(ctx: MsgContext): {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
} | null {
  const channelRaw = normalizeSessionText(
    ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "",
  ).toLowerCase();
  if (!channelRaw) {
    return null;
  }
  const accountId = normalizeSessionText(ctx.AccountId) || "default";
  const normalizedThreadId =
    ctx.MessageThreadId != null ? normalizeSessionText(String(ctx.MessageThreadId)) : "";

  if (channelRaw === "telegram") {
    const parentConversationId =
      parseTelegramChatIdFromTarget(ctx.OriginatingTo) ?? parseTelegramChatIdFromTarget(ctx.To);
    let conversationId =
      resolveConversationIdFromTargets({
        threadId: normalizedThreadId || undefined,
        targets: [ctx.OriginatingTo, ctx.To],
      }) ?? "";
    if (normalizedThreadId && parentConversationId) {
      conversationId =
        buildTelegramTopicConversationId({
          chatId: parentConversationId,
          topicId: normalizedThreadId,
        }) ?? conversationId;
    }
    if (!conversationId) {
      return null;
    }
    return {
      channel: channelRaw,
      accountId,
      conversationId,
      ...(parentConversationId ? { parentConversationId } : {}),
    };
  }

  const conversationId = resolveConversationIdFromTargets({
    threadId: normalizedThreadId || undefined,
    targets: [ctx.OriginatingTo, ctx.To],
  });
  if (!conversationId) {
    return null;
  }
  let parentConversationId: string | undefined;
  if (channelRaw === "discord" && normalizedThreadId) {
    const fromContext = normalizeSessionText(ctx.ThreadParentId);
    if (fromContext && fromContext !== conversationId) {
      parentConversationId = fromContext;
    } else {
      const fromParentSession = parseDiscordParentChannelFromSessionKey(ctx.ParentSessionKey);
      if (fromParentSession && fromParentSession !== conversationId) {
        parentConversationId = fromParentSession;
      } else {
        const fromTargets = resolveConversationIdFromTargets({
          targets: [ctx.OriginatingTo, ctx.To],
        });
        if (fromTargets && fromTargets !== conversationId) {
          parentConversationId = fromTargets;
        }
      }
    }
  }
  return {
    channel: channelRaw,
    accountId,
    conversationId,
    ...(parentConversationId ? { parentConversationId } : {}),
  };
}

function resolveBoundAcpSessionForReset(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): string | undefined {
  const activeSessionKey = normalizeSessionText(params.ctx.SessionKey);
  const bindingContext = resolveAcpResetBindingContext(params.ctx);
  return resolveEffectiveResetTargetSessionKey({
    cfg: params.cfg,
    channel: bindingContext?.channel,
    accountId: bindingContext?.accountId,
    conversationId: bindingContext?.conversationId,
    parentConversationId: bindingContext?.parentConversationId,
    activeSessionKey,
    allowNonAcpBindingSessionKey: false,
    skipConfiguredFallbackWhenActiveSessionNonAcp: true,
    fallbackToActiveAcpWhenUnbound: false,
  });
}

export async function initSessionState(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
}): Promise<SessionInitResult> {
  const { ctx, cfg, commandAuthorized } = params;
  // Native slash commands (Telegram/Discord/Slack) are delivered on a separate
  // "slash session" key, but should mutate the target chat session.
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const sessionCtxForState =
    targetSessionKey && targetSessionKey !== ctx.SessionKey
      ? { ...ctx, SessionKey: targetSessionKey }
      : ctx;
  const sessionCfg = cfg.session;
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const agentId = resolveSessionAgentId({
    sessionKey: sessionCtxForState.SessionKey,
    config: cfg,
  });
  const groupResolution = resolveGroupSessionKey(sessionCtxForState) ?? undefined;
  const resetTriggers = sessionCfg?.resetTriggers?.length
    ? sessionCfg.resetTriggers
    : DEFAULT_RESET_TRIGGERS;
  const parentForkMaxTokens = resolveParentForkMaxTokens(cfg);
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });

  // CRITICAL: Skip cache to ensure fresh data when resolving session identity.
  // Stale cache (especially with multiple gateway processes or on Windows where
  // mtime granularity may miss rapid writes) can cause incorrect sessionId
  // generation, leading to orphaned transcript files. See #17971.
  const sessionStore: Record<string, SessionEntry> = loadSessionStore(storePath, {
    skipCache: true,
  });
  let sessionKey: string | undefined;
  let sessionEntry: SessionEntry;

  let sessionId: string | undefined;
  let isNewSession = false;
  let bodyStripped: string | undefined;
  let systemSent = false;
  let abortedLastRun = false;
  let resetTriggered = false;

  let persistedThinking: string | undefined;
  let persistedVerbose: string | undefined;
  let persistedReasoning: string | undefined;
  let persistedTtsAuto: TtsAutoMode | undefined;
  let persistedModelOverride: string | undefined;
  let persistedProviderOverride: string | undefined;
  let persistedLabel: string | undefined;

  const normalizedChatType = normalizeChatType(ctx.ChatType);
  const isGroup =
    normalizedChatType != null && normalizedChatType !== "direct" ? true : Boolean(groupResolution);
  // Prefer CommandBody/RawBody (clean message) for command detection; fall back
  // to Body which may contain structural context (history, sender labels).
  const commandSource = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "";
  // IMPORTANT: do NOT lowercase the entire command body.
  // Users often pass case-sensitive arguments (e.g. filesystem paths on Linux).
  // Command parsing downstream lowercases only the command token for matching.
  const triggerBodyNormalized = stripStructuralPrefixes(commandSource).trim();

  // Use CommandBody/RawBody for reset trigger matching (clean message without structural context).
  const rawBody = commandSource;
  const trimmedBody = rawBody.trim();
  const resetAuthorized = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized,
  }).isAuthorizedSender;
  // Timestamp/message prefixes (e.g. "[Dec 4 17:35] ") are added by the
  // web inbox before we get here. They prevented reset triggers like "/new"
  // from matching, so strip structural wrappers when checking for resets.
  const strippedForReset = isGroup
    ? stripMentions(triggerBodyNormalized, ctx, cfg, agentId)
    : triggerBodyNormalized;
  const shouldUseAcpInPlaceReset = Boolean(
    resolveBoundAcpSessionForReset({
      cfg,
      ctx: sessionCtxForState,
    }),
  );
  const shouldBypassAcpResetForTrigger = (triggerLower: string): boolean =>
    shouldUseAcpInPlaceReset &&
    DEFAULT_RESET_TRIGGERS.some((defaultTrigger) => defaultTrigger.toLowerCase() === triggerLower);

  // Reset triggers are configured as lowercased commands (e.g. "/new"), but users may type
  // "/NEW" etc. Match case-insensitively while keeping the original casing for any stripped body.
  const trimmedBodyLower = trimmedBody.toLowerCase();
  const strippedForResetLower = strippedForReset.toLowerCase();

  for (const trigger of resetTriggers) {
    if (!trigger) {
      continue;
    }
    if (!resetAuthorized) {
      break;
    }
    const triggerLower = trigger.toLowerCase();
    if (trimmedBodyLower === triggerLower || strippedForResetLower === triggerLower) {
      if (shouldBypassAcpResetForTrigger(triggerLower)) {
        // ACP-bound conversations handle /new and /reset in command handling
        // so the bound ACP runtime can be reset in place without rotating the
        // normal OpenClaw session/transcript.
        break;
      }
      isNewSession = true;
      bodyStripped = "";
      resetTriggered = true;
      break;
    }
    const triggerPrefixLower = `${triggerLower} `;
    if (
      trimmedBodyLower.startsWith(triggerPrefixLower) ||
      strippedForResetLower.startsWith(triggerPrefixLower)
    ) {
      if (shouldBypassAcpResetForTrigger(triggerLower)) {
        break;
      }
      isNewSession = true;
      bodyStripped = strippedForReset.slice(trigger.length).trimStart();
      resetTriggered = true;
      break;
    }
  }

  sessionKey = resolveSessionKey(sessionScope, sessionCtxForState, mainKey);
  const retiredLegacyMainDelivery = maybeRetireLegacyMainDeliveryRoute({
    sessionCfg,
    sessionKey,
    sessionStore,
    agentId,
    mainKey,
    isGroup,
    ctx,
  });
  if (retiredLegacyMainDelivery) {
    sessionStore[retiredLegacyMainDelivery.key] = retiredLegacyMainDelivery.entry;
  }
  const entry = sessionStore[sessionKey];
  const now = Date.now();
  const isThread = resolveThreadFlag({
    sessionKey,
    messageThreadId: ctx.MessageThreadId,
    threadLabel: ctx.ThreadLabel,
    threadStarterBody: ctx.ThreadStarterBody,
    parentSessionKey: ctx.ParentSessionKey,
  });
  const resetType = resolveSessionResetType({ sessionKey, isGroup, isThread });
  const channelReset = resolveChannelResetConfig({
    sessionCfg,
    channel:
      groupResolution?.channel ??
      (ctx.OriginatingChannel as string | undefined) ??
      ctx.Surface ??
      ctx.Provider,
  });
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg,
    resetType,
    resetOverride: channelReset,
  });
  const freshEntry = entry
    ? evaluateSessionFreshness({ updatedAt: entry.updatedAt, now, policy: resetPolicy }).fresh
    : false;
  // Capture the current session entry before any reset so its transcript can be
  // archived afterward.  We need to do this for both explicit resets (/new, /reset)
  // and for scheduled/daily resets where the session has become stale (!freshEntry).
  // Without this, daily-reset transcripts are left as orphaned files on disk (#35481).
  const previousSessionEntry = (resetTriggered || !freshEntry) && entry ? { ...entry } : undefined;
  clearBootstrapSnapshotOnSessionRollover({
    sessionKey,
    previousSessionId: previousSessionEntry?.sessionId,
  });

  if (!isNewSession && freshEntry) {
    sessionId = entry.sessionId;
    systemSent = entry.systemSent ?? false;
    abortedLastRun = entry.abortedLastRun ?? false;
    persistedThinking = entry.thinkingLevel;
    persistedVerbose = entry.verboseLevel;
    persistedReasoning = entry.reasoningLevel;
    persistedTtsAuto = entry.ttsAuto;
    persistedModelOverride = entry.modelOverride;
    persistedProviderOverride = entry.providerOverride;
    persistedLabel = entry.label;
  } else {
    sessionId = crypto.randomUUID();
    isNewSession = true;
    systemSent = false;
    abortedLastRun = false;
    // When a reset trigger (/new, /reset) starts a new session, carry over
    // user-set behavior overrides (verbose, thinking, reasoning, ttsAuto)
    // so the user doesn't have to re-enable them every time.
    if (resetTriggered && entry) {
      persistedThinking = entry.thinkingLevel;
      persistedVerbose = entry.verboseLevel;
      persistedReasoning = entry.reasoningLevel;
      persistedTtsAuto = entry.ttsAuto;
      persistedModelOverride = entry.modelOverride;
      persistedProviderOverride = entry.providerOverride;
      persistedLabel = entry.label;
    }
  }

  const baseEntry = !isNewSession && freshEntry ? entry : undefined;
  // Track the originating channel/to for announce routing (subagent announce-back).
  const originatingChannelRaw = ctx.OriginatingChannel as string | undefined;
  const lastChannelRaw = resolveLastChannelRaw({
    originatingChannelRaw,
    persistedLastChannel: baseEntry?.lastChannel,
    sessionKey,
  });
  const lastToRaw = resolveLastToRaw({
    originatingChannelRaw,
    originatingToRaw: ctx.OriginatingTo,
    toRaw: ctx.To,
    persistedLastTo: baseEntry?.lastTo,
    persistedLastChannel: baseEntry?.lastChannel,
    sessionKey,
  });
  const lastAccountIdRaw = ctx.AccountId || baseEntry?.lastAccountId;
  // Only fall back to persisted threadId for thread sessions.  Non-thread
  // sessions (e.g. DM without topics) must not inherit a stale threadId from a
  // previous interaction that happened inside a topic/thread.
  const lastThreadIdRaw = ctx.MessageThreadId || (isThread ? baseEntry?.lastThreadId : undefined);
  const deliveryFields = normalizeSessionDeliveryFields({
    deliveryContext: {
      channel: lastChannelRaw,
      to: lastToRaw,
      accountId: lastAccountIdRaw,
      threadId: lastThreadIdRaw,
    },
  });
  const lastChannel = deliveryFields.lastChannel ?? lastChannelRaw;
  const lastTo = deliveryFields.lastTo ?? lastToRaw;
  const lastAccountId = deliveryFields.lastAccountId ?? lastAccountIdRaw;
  const lastThreadId = deliveryFields.lastThreadId ?? lastThreadIdRaw;
  sessionEntry = {
    ...baseEntry,
    sessionId,
    updatedAt: Date.now(),
    systemSent,
    abortedLastRun,
    // Persist previously stored thinking/verbose levels when present.
    thinkingLevel: persistedThinking ?? baseEntry?.thinkingLevel,
    verboseLevel: persistedVerbose ?? baseEntry?.verboseLevel,
    reasoningLevel: persistedReasoning ?? baseEntry?.reasoningLevel,
    ttsAuto: persistedTtsAuto ?? baseEntry?.ttsAuto,
    responseUsage: baseEntry?.responseUsage,
    modelOverride: persistedModelOverride ?? baseEntry?.modelOverride,
    providerOverride: persistedProviderOverride ?? baseEntry?.providerOverride,
    label: persistedLabel ?? baseEntry?.label,
    sendPolicy: baseEntry?.sendPolicy,
    queueMode: baseEntry?.queueMode,
    queueDebounceMs: baseEntry?.queueDebounceMs,
    queueCap: baseEntry?.queueCap,
    queueDrop: baseEntry?.queueDrop,
    displayName: baseEntry?.displayName,
    chatType: baseEntry?.chatType,
    channel: baseEntry?.channel,
    groupId: baseEntry?.groupId,
    subject: baseEntry?.subject,
    groupChannel: baseEntry?.groupChannel,
    space: baseEntry?.space,
    deliveryContext: deliveryFields.deliveryContext,
    // Track originating channel for subagent announce routing.
    lastChannel,
    lastTo,
    lastAccountId,
    lastThreadId,
  };
  const metaPatch = deriveSessionMetaPatch({
    ctx: sessionCtxForState,
    sessionKey,
    existing: sessionEntry,
    groupResolution,
  });
  if (metaPatch) {
    sessionEntry = { ...sessionEntry, ...metaPatch };
  }
  if (!sessionEntry.chatType) {
    sessionEntry.chatType = "direct";
  }
  const threadLabel = ctx.ThreadLabel?.trim();
  if (threadLabel) {
    sessionEntry.displayName = threadLabel;
  }
  const parentSessionKey = ctx.ParentSessionKey?.trim();
  const alreadyForked = sessionEntry.forkedFromParent === true;
  if (
    parentSessionKey &&
    parentSessionKey !== sessionKey &&
    sessionStore[parentSessionKey] &&
    !alreadyForked
  ) {
    const parentTokens = sessionStore[parentSessionKey].totalTokens ?? 0;
    if (parentForkMaxTokens > 0 && parentTokens > parentForkMaxTokens) {
      // Parent context is too large — forking would create a thread session
      // that immediately overflows the model's context window. Start fresh
      // instead and mark as forked to prevent re-attempts. See #26905.
      log.warn(
        `skipping parent fork (parent too large): parentKey=${parentSessionKey} → sessionKey=${sessionKey} ` +
          `parentTokens=${parentTokens} maxTokens=${parentForkMaxTokens}`,
      );
      sessionEntry.forkedFromParent = true;
    } else {
      log.warn(
        `forking from parent session: parentKey=${parentSessionKey} → sessionKey=${sessionKey} ` +
          `parentTokens=${parentTokens}`,
      );
      const forked = forkSessionFromParent({
        parentEntry: sessionStore[parentSessionKey],
        agentId,
        sessionsDir: path.dirname(storePath),
      });
      if (forked) {
        sessionId = forked.sessionId;
        sessionEntry.sessionId = forked.sessionId;
        sessionEntry.sessionFile = forked.sessionFile;
        sessionEntry.forkedFromParent = true;
        log.warn(`forked session created: file=${forked.sessionFile}`);
      }
    }
  }
  const fallbackSessionFile = !sessionEntry.sessionFile
    ? resolveSessionTranscriptPath(sessionEntry.sessionId, agentId, ctx.MessageThreadId)
    : undefined;
  const resolvedSessionFile = await resolveAndPersistSessionFile({
    sessionId: sessionEntry.sessionId,
    sessionKey,
    sessionStore,
    storePath,
    sessionEntry,
    agentId,
    sessionsDir: path.dirname(storePath),
    fallbackSessionFile,
    activeSessionKey: sessionKey,
  });
  sessionEntry = resolvedSessionFile.sessionEntry;
  if (isNewSession) {
    sessionEntry.compactionCount = 0;
    sessionEntry.memoryFlushCompactionCount = undefined;
    sessionEntry.memoryFlushAt = undefined;
    // Clear stale token metrics from previous session so /status doesn't
    // display the old session's context usage after /new or /reset.
    sessionEntry.totalTokens = undefined;
    sessionEntry.inputTokens = undefined;
    sessionEntry.outputTokens = undefined;
    sessionEntry.contextTokens = undefined;
  }
  // Preserve per-session overrides while resetting compaction state on /new.
  sessionStore[sessionKey] = { ...sessionStore[sessionKey], ...sessionEntry };
  await updateSessionStore(
    storePath,
    (store) => {
      // Preserve per-session overrides while resetting compaction state on /new.
      store[sessionKey] = { ...store[sessionKey], ...sessionEntry };
      if (retiredLegacyMainDelivery) {
        store[retiredLegacyMainDelivery.key] = retiredLegacyMainDelivery.entry;
      }
    },
    {
      activeSessionKey: sessionKey,
      onWarn: (warning) =>
        deliverSessionMaintenanceWarning({
          cfg,
          sessionKey,
          entry: sessionEntry,
          warning,
        }),
    },
  );

  // Archive old transcript so it doesn't accumulate on disk (#14869).
  if (previousSessionEntry?.sessionId) {
    archiveSessionTranscripts({
      sessionId: previousSessionEntry.sessionId,
      storePath,
      sessionFile: previousSessionEntry.sessionFile,
      agentId,
      reason: "reset",
    });
    await cleanupSessionSanitizationArtifacts({
      agentId,
      sessionId: previousSessionEntry.sessionId,
    });
  }

  const sessionCtx: TemplateContext = {
    ...ctx,
    // Keep BodyStripped aligned with Body (best default for agent prompts).
    // RawBody is reserved for command/directive parsing and may omit context.
    BodyStripped: normalizeInboundTextNewlines(
      bodyStripped ??
        ctx.BodyForAgent ??
        ctx.Body ??
        ctx.CommandBody ??
        ctx.RawBody ??
        ctx.BodyForCommands ??
        "",
    ),
    SessionId: sessionId,
    IsNewSession: isNewSession ? "true" : "false",
  };

  // Run session plugin hooks (fire-and-forget)
  const hookRunner = getGlobalHookRunner();
  if (hookRunner && isNewSession) {
    const effectiveSessionId = sessionId ?? "";

    // If replacing an existing session, fire session_end for the old one
    if (previousSessionEntry?.sessionId && previousSessionEntry.sessionId !== effectiveSessionId) {
      if (hookRunner.hasHooks("session_end")) {
        const payload = buildSessionEndHookPayload({
          sessionId: previousSessionEntry.sessionId,
          sessionKey,
          cfg,
        });
        void hookRunner.runSessionEnd(payload.event, payload.context).catch(() => {});
      }
    }

    // Fire session_start for the new session
    if (hookRunner.hasHooks("session_start")) {
      const payload = buildSessionStartHookPayload({
        sessionId: effectiveSessionId,
        sessionKey,
        cfg,
        resumedFrom: previousSessionEntry?.sessionId,
      });
      void hookRunner.runSessionStart(payload.event, payload.context).catch(() => {});
    }
  }

  return {
    sessionCtx,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    sessionId: sessionId ?? crypto.randomUUID(),
    isNewSession,
    resetTriggered,
    systemSent,
    abortedLastRun,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    bodyStripped,
    triggerBodyNormalized,
  };
}
