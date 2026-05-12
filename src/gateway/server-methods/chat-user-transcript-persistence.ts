import { getCliSessionBinding } from "../../agents/cli-session.js";
import {
  isEmbeddedPiRunActive,
  resolveActiveEmbeddedRunSessionId,
} from "../../agents/pi-embedded-runner/runs.js";
import { initSessionState } from "../../auto-reply/reply/session.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  DEFAULT_RESET_TRIGGERS,
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionLifecycleTimestamps,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
  type SessionEntry,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadSessionEntry } from "../session-utils.js";
import type { GatewayRequestContext } from "./types.js";

export type ChatSendTranscriptSessionTarget = {
  storePath: string;
  entry?: SessionEntry;
  sessionId?: string;
  sessionKey: string;
};

export function isChatSendResetCommandMessage(message: string, cfg: OpenClawConfig): boolean {
  const trimmed = message.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }
  const resetTriggers = cfg.session?.resetTriggers?.length
    ? cfg.session.resetTriggers
    : DEFAULT_RESET_TRIGGERS;
  for (const trigger of resetTriggers) {
    const normalized = trigger.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (trimmed === normalized || trimmed.startsWith(`${normalized} `)) {
      return true;
    }
  }
  return false;
}

function hasProviderOwnedSessionEntry(entry: SessionEntry | undefined): boolean {
  const provider =
    typeof entry?.providerOverride === "string" ? entry.providerOverride : entry?.modelProvider;
  return Boolean(provider && getCliSessionBinding(entry, provider));
}

export function isChatSendSessionBusyForEagerPersistence(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers">;
  rawSessionKey: string;
  sessionKey: string;
  clientRunId: string;
  sessionId?: string;
}): boolean {
  for (const [runId, active] of params.context.chatAbortControllers) {
    if (runId === params.clientRunId) {
      continue;
    }
    if (active.sessionKey === params.rawSessionKey || active.sessionKey === params.sessionKey) {
      return true;
    }
  }

  const activeSessionId =
    resolveActiveEmbeddedRunSessionId(params.sessionKey) ??
    resolveActiveEmbeddedRunSessionId(params.rawSessionKey) ??
    params.sessionId;
  return Boolean(activeSessionId && isEmbeddedPiRunActive(activeSessionId));
}

function isGroupChatContext(ctx: MsgContext): boolean {
  const chatType = typeof ctx.ChatType === "string" ? ctx.ChatType.toLowerCase() : "";
  return chatType === "group" || chatType === "channel";
}

function shouldRefreshChatSendTranscriptSessionTarget(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  sessionKey: string;
  entry?: SessionEntry;
  storePath: string;
  agentId: string;
  now: number;
}): boolean {
  const entry = params.entry;
  if (
    !entry?.sessionId ||
    typeof entry.updatedAt !== "number" ||
    !Number.isFinite(entry.updatedAt)
  ) {
    return false;
  }
  const sessionCfg = params.cfg.session;
  const isThread = resolveThreadFlag({
    sessionKey: params.sessionKey,
    messageThreadId: params.ctx.MessageThreadId,
    threadLabel: params.ctx.ThreadLabel,
    threadStarterBody: params.ctx.ThreadStarterBody,
    parentSessionKey: params.ctx.ParentSessionKey,
  });
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg,
    resetType: resolveSessionResetType({
      sessionKey: params.sessionKey,
      isGroup: isGroupChatContext(params.ctx),
      isThread,
    }),
    resetOverride: resolveChannelResetConfig({
      sessionCfg,
      channel:
        (params.ctx.OriginatingChannel as string | undefined) ??
        params.ctx.Surface ??
        params.ctx.Provider,
    }),
  });
  if (hasProviderOwnedSessionEntry(entry) && resetPolicy.configured !== true) {
    return false;
  }
  const lifecycleTimestamps = resolveSessionLifecycleTimestamps({
    entry,
    agentId: params.agentId,
    storePath: params.storePath,
  });
  return !evaluateSessionFreshness({
    updatedAt: entry.updatedAt,
    sessionStartedAt: lifecycleTimestamps.sessionStartedAt,
    lastInteractionAt: lifecycleTimestamps.lastInteractionAt,
    now: params.now,
    policy: resetPolicy,
  }).fresh;
}

export async function resolveChatSendTranscriptSessionTarget(params: {
  sessionKey: string;
  backingSessionId?: string;
  cfg: OpenClawConfig;
  ctx: MsgContext;
  agentId: string;
  message: string;
  now: number;
}): Promise<ChatSendTranscriptSessionTarget> {
  const { storePath, entry } = loadSessionEntry(params.sessionKey, { skipCache: true });
  if (
    !isChatSendResetCommandMessage(params.message, params.cfg) &&
    shouldRefreshChatSendTranscriptSessionTarget({
      cfg: params.cfg,
      ctx: params.ctx,
      sessionKey: params.sessionKey,
      entry,
      storePath,
      agentId: params.agentId,
      now: params.now,
    })
  ) {
    const initialized = await initSessionState({
      ctx: params.ctx,
      cfg: params.cfg,
      commandAuthorized: true,
    });
    return {
      storePath: initialized.storePath,
      entry: initialized.sessionEntry,
      sessionId: initialized.sessionId,
      sessionKey: initialized.sessionKey,
    };
  }
  return {
    storePath,
    entry,
    sessionId: entry?.sessionId ?? params.backingSessionId,
    sessionKey: params.sessionKey,
  };
}
