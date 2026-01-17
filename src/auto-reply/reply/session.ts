import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { getChannelDock } from "../../channels/dock.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import type { ClawdbotConfig } from "../../config/config.js";
import {
  buildGroupDisplayName,
  DEFAULT_IDLE_MINUTES,
  DEFAULT_RESET_TRIGGERS,
  type GroupKeyResolution,
  loadSessionStore,
  resolveGroupSessionKey,
  resolveSessionFilePath,
  resolveSessionKey,
  resolveSessionTranscriptPath,
  resolveStorePath,
  type SessionEntry,
  type SessionScope,
  updateSessionStore,
} from "../../config/sessions.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import { formatInboundBodyWithSenderMeta } from "./inbound-sender-meta.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";
import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.js";

export type SessionInitResult = {
  sessionCtx: TemplateContext;
  sessionEntry: SessionEntry;
  previousSessionEntry?: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  sessionId: string;
  isNewSession: boolean;
  systemSent: boolean;
  abortedLastRun: boolean;
  storePath: string;
  sessionScope: SessionScope;
  groupResolution?: GroupKeyResolution;
  isGroup: boolean;
  bodyStripped?: string;
  triggerBodyNormalized: string;
};

function forkSessionFromParent(params: {
  parentEntry: SessionEntry;
}): { sessionId: string; sessionFile: string } | null {
  const parentSessionFile = resolveSessionFilePath(
    params.parentEntry.sessionId,
    params.parentEntry,
  );
  if (!parentSessionFile || !fs.existsSync(parentSessionFile)) return null;
  try {
    const manager = SessionManager.open(parentSessionFile);
    const leafId = manager.getLeafId();
    if (leafId) {
      const sessionFile = manager.createBranchedSession(leafId) ?? manager.getSessionFile();
      const sessionId = manager.getSessionId();
      if (sessionFile && sessionId) return { sessionId, sessionFile };
    }
    const sessionId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    const sessionFile = path.join(manager.getSessionDir(), `${fileTimestamp}_${sessionId}.jsonl`);
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
      timestamp,
      cwd: manager.getCwd(),
      parentSession: parentSessionFile,
    };
    fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf-8");
    return { sessionId, sessionFile };
  } catch {
    return null;
  }
}

export async function initSessionState(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
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
  const resetTriggers = sessionCfg?.resetTriggers?.length
    ? sessionCfg.resetTriggers
    : DEFAULT_RESET_TRIGGERS;
  const idleMinutes = Math.max(sessionCfg?.idleMinutes ?? DEFAULT_IDLE_MINUTES, 1);
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });

  const sessionStore: Record<string, SessionEntry> = loadSessionStore(storePath);
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
  let persistedModelOverride: string | undefined;
  let persistedProviderOverride: string | undefined;

  const groupResolution = resolveGroupSessionKey(sessionCtxForState) ?? undefined;
  const normalizedChatType = normalizeChatType(ctx.ChatType);
  const isGroup =
    normalizedChatType != null && normalizedChatType !== "direct" ? true : Boolean(groupResolution);
  // Prefer CommandBody/RawBody (clean message) for command detection; fall back
  // to Body which may contain structural context (history, sender labels).
  const commandSource = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "";
  const triggerBodyNormalized = stripStructuralPrefixes(commandSource).trim().toLowerCase();

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
  for (const trigger of resetTriggers) {
    if (!trigger) continue;
    if (!resetAuthorized) break;
    if (trimmedBody === trigger || strippedForReset === trigger) {
      isNewSession = true;
      bodyStripped = "";
      resetTriggered = true;
      break;
    }
    const triggerPrefix = `${trigger} `;
    if (trimmedBody.startsWith(triggerPrefix) || strippedForReset.startsWith(triggerPrefix)) {
      isNewSession = true;
      bodyStripped = strippedForReset.slice(trigger.length).trimStart();
      resetTriggered = true;
      break;
    }
  }

  sessionKey = resolveSessionKey(sessionScope, sessionCtxForState, mainKey);
  const entry = sessionStore[sessionKey];
  const previousSessionEntry = resetTriggered && entry ? { ...entry } : undefined;
  const idleMs = idleMinutes * 60_000;
  const freshEntry = entry && Date.now() - entry.updatedAt <= idleMs;

  if (!isNewSession && freshEntry) {
    sessionId = entry.sessionId;
    systemSent = entry.systemSent ?? false;
    abortedLastRun = entry.abortedLastRun ?? false;
    persistedThinking = entry.thinkingLevel;
    persistedVerbose = entry.verboseLevel;
    persistedReasoning = entry.reasoningLevel;
    persistedModelOverride = entry.modelOverride;
    persistedProviderOverride = entry.providerOverride;
  } else {
    sessionId = crypto.randomUUID();
    isNewSession = true;
    systemSent = false;
    abortedLastRun = false;
  }

  const baseEntry = !isNewSession && freshEntry ? entry : undefined;
  // Track the originating channel/to for announce routing (subagent announce-back).
  const lastChannelRaw = (ctx.OriginatingChannel as string | undefined) || baseEntry?.lastChannel;
  const lastToRaw = (ctx.OriginatingTo as string | undefined) || ctx.To || baseEntry?.lastTo;
  const lastAccountIdRaw = (ctx.AccountId as string | undefined) || baseEntry?.lastAccountId;
  const deliveryFields = normalizeSessionDeliveryFields({
    deliveryContext: {
      channel: lastChannelRaw,
      to: lastToRaw,
      accountId: lastAccountIdRaw,
    },
  });
  const lastChannel = deliveryFields.lastChannel ?? lastChannelRaw;
  const lastTo = deliveryFields.lastTo ?? lastToRaw;
  const lastAccountId = deliveryFields.lastAccountId ?? lastAccountIdRaw;
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
    responseUsage: baseEntry?.responseUsage,
    modelOverride: persistedModelOverride ?? baseEntry?.modelOverride,
    providerOverride: persistedProviderOverride ?? baseEntry?.providerOverride,
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
  };
  if (groupResolution?.channel) {
    const channel = groupResolution.channel;
    const subject = ctx.GroupSubject?.trim();
    const space = ctx.GroupSpace?.trim();
    const explicitChannel = ctx.GroupChannel?.trim();
    const normalizedChannel = normalizeChannelId(channel);
    const isChannelProvider = Boolean(
      normalizedChannel &&
      getChannelDock(normalizedChannel)?.capabilities.chatTypes.includes("channel"),
    );
    const nextGroupChannel =
      explicitChannel ??
      ((groupResolution.chatType === "channel" || isChannelProvider) &&
      subject &&
      subject.startsWith("#")
        ? subject
        : undefined);
    const nextSubject = nextGroupChannel ? undefined : subject;
    sessionEntry.chatType = groupResolution.chatType ?? "group";
    sessionEntry.channel = channel;
    sessionEntry.groupId = groupResolution.id;
    if (nextSubject) sessionEntry.subject = nextSubject;
    if (nextGroupChannel) sessionEntry.groupChannel = nextGroupChannel;
    if (space) sessionEntry.space = space;
    sessionEntry.displayName = buildGroupDisplayName({
      provider: sessionEntry.channel,
      subject: sessionEntry.subject,
      groupChannel: sessionEntry.groupChannel,
      space: sessionEntry.space,
      id: groupResolution.id,
      key: sessionKey,
    });
  } else if (!sessionEntry.chatType) {
    sessionEntry.chatType = "direct";
  }
  const threadLabel = ctx.ThreadLabel?.trim();
  if (threadLabel) {
    sessionEntry.displayName = threadLabel;
  }
  const parentSessionKey = ctx.ParentSessionKey?.trim();
  if (
    isNewSession &&
    parentSessionKey &&
    parentSessionKey !== sessionKey &&
    sessionStore[parentSessionKey]
  ) {
    const forked = forkSessionFromParent({
      parentEntry: sessionStore[parentSessionKey],
    });
    if (forked) {
      sessionId = forked.sessionId;
      sessionEntry.sessionId = forked.sessionId;
      sessionEntry.sessionFile = forked.sessionFile;
    }
  }
  if (!sessionEntry.sessionFile) {
    sessionEntry.sessionFile = resolveSessionTranscriptPath(
      sessionEntry.sessionId,
      agentId,
      ctx.MessageThreadId,
    );
  }
  if (isNewSession) {
    sessionEntry.compactionCount = 0;
    sessionEntry.memoryFlushCompactionCount = undefined;
    sessionEntry.memoryFlushAt = undefined;
  }
  // Preserve per-session overrides while resetting compaction state on /new.
  sessionStore[sessionKey] = { ...sessionStore[sessionKey], ...sessionEntry };
  await updateSessionStore(storePath, (store) => {
    // Preserve per-session overrides while resetting compaction state on /new.
    store[sessionKey] = { ...store[sessionKey], ...sessionEntry };
  });

  const sessionCtx: TemplateContext = {
    ...ctx,
    // Keep BodyStripped aligned with Body (best default for agent prompts).
    // RawBody is reserved for command/directive parsing and may omit context.
    BodyStripped: formatInboundBodyWithSenderMeta({
      ctx,
      body: normalizeInboundTextNewlines(
        bodyStripped ??
          ctx.BodyForAgent ??
          ctx.Body ??
          ctx.CommandBody ??
          ctx.RawBody ??
          ctx.BodyForCommands ??
          "",
      ),
    }),
    SessionId: sessionId,
    IsNewSession: isNewSession ? "true" : "false",
  };

  return {
    sessionCtx,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    sessionId: sessionId ?? crypto.randomUUID(),
    isNewSession,
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
