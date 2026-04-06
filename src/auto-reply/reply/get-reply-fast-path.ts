import crypto from "node:crypto";
import path from "node:path";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/config.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import type { SessionInitResult } from "./session.js";

const COMPLETE_REPLY_CONFIG_SYMBOL = Symbol.for("openclaw.reply.complete-config");

type ReplyConfigWithMarker = OpenClawConfig & {
  [COMPLETE_REPLY_CONFIG_SYMBOL]?: true;
};

function isSlowReplyTestAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.OPENCLAW_ALLOW_SLOW_REPLY_TESTS === "1" || env.OPENCLAW_STRICT_FAST_REPLY_CONFIG === "0"
  );
}

function resolveFastSessionKey(ctx: MsgContext): string {
  const existing = ctx.SessionKey?.trim();
  if (existing) {
    return existing;
  }
  const provider = ctx.Provider?.trim() || ctx.Surface?.trim() || "main";
  const destination = ctx.To?.trim() || ctx.From?.trim() || "default";
  return `agent:main:${provider}:${destination}`;
}

export function markCompleteReplyConfig<T extends OpenClawConfig>(config: T): T {
  Object.defineProperty(config as ReplyConfigWithMarker, COMPLETE_REPLY_CONFIG_SYMBOL, {
    value: true,
    configurable: true,
    enumerable: false,
  });
  return config;
}

export function withFastReplyConfig<T extends OpenClawConfig>(config: T): T {
  return markCompleteReplyConfig(config);
}

export function isCompleteReplyConfig(config: unknown): config is OpenClawConfig {
  return Boolean(
    config &&
    typeof config === "object" &&
    (config as ReplyConfigWithMarker)[COMPLETE_REPLY_CONFIG_SYMBOL] === true,
  );
}

export function resolveGetReplyConfig(params: {
  loadConfig: () => OpenClawConfig;
  isFastTestEnv: boolean;
  configOverride?: OpenClawConfig;
}): OpenClawConfig {
  const { configOverride } = params;
  if (configOverride == null) {
    return params.loadConfig();
  }
  if (params.isFastTestEnv && !isCompleteReplyConfig(configOverride) && !isSlowReplyTestAllowed()) {
    throw new Error(
      "Fast reply tests must pass with withFastReplyConfig()/markCompleteReplyConfig(); set OPENCLAW_ALLOW_SLOW_REPLY_TESTS=1 to opt out.",
    );
  }
  if (params.isFastTestEnv && isCompleteReplyConfig(configOverride)) {
    return configOverride;
  }
  return applyMergePatch(params.loadConfig(), configOverride) as OpenClawConfig;
}

export function shouldUseReplyFastTestBootstrap(params: {
  isFastTestEnv: boolean;
  configOverride?: OpenClawConfig;
}): boolean {
  return params.isFastTestEnv && isCompleteReplyConfig(params.configOverride);
}

export function shouldUseReplyFastTestRuntime(params: {
  cfg: OpenClawConfig;
  isFastTestEnv: boolean;
}): boolean {
  return params.isFastTestEnv && isCompleteReplyConfig(params.cfg);
}

export function shouldUseReplyFastDirectiveExecution(params: {
  isFastTestBootstrap: boolean;
  isGroup: boolean;
  isHeartbeat: boolean;
  resetTriggered: boolean;
  triggerBodyNormalized: string;
}): boolean {
  if (
    !params.isFastTestBootstrap ||
    params.isGroup ||
    params.isHeartbeat ||
    params.resetTriggered
  ) {
    return false;
  }
  return !params.triggerBodyNormalized.includes("/");
}

export function initFastReplySessionState(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  commandAuthorized: boolean;
  workspaceDir: string;
}): SessionInitResult {
  const { ctx, cfg, agentId, commandAuthorized, workspaceDir } = params;
  const sessionScope = cfg.session?.scope ?? "per-sender";
  const sessionKey = resolveFastSessionKey(ctx);
  const sessionId = crypto.randomUUID();
  const commandSource = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "";
  const triggerBodyNormalized = stripStructuralPrefixes(commandSource).trim();
  const normalizedChatType = normalizeChatType(ctx.ChatType);
  const isGroup = normalizedChatType != null && normalizedChatType !== "direct";
  const strippedForReset = isGroup
    ? stripMentions(triggerBodyNormalized, ctx, cfg, agentId)
    : triggerBodyNormalized;
  const resetMatch = strippedForReset.match(/^\/(new|reset)(?:\s|$)/i);
  const resetTriggered = Boolean(resetMatch);
  const bodyStripped = resetTriggered
    ? strippedForReset.slice(resetMatch?.[0].length ?? 0).trimStart()
    : (ctx.BodyForAgent ?? ctx.Body ?? "");
  const now = Date.now();
  const sessionFile = path.join(workspaceDir, ".openclaw", "sessions", `${sessionId}.jsonl`);
  const sessionEntry: SessionEntry = {
    sessionId,
    sessionFile,
    updatedAt: now,
    ...(normalizedChatType ? { chatType: normalizedChatType } : {}),
    ...(ctx.Provider?.trim() ? { channel: ctx.Provider.trim() } : {}),
    ...(ctx.GroupSubject?.trim() ? { subject: ctx.GroupSubject.trim() } : {}),
    ...(ctx.GroupChannel?.trim() ? { groupChannel: ctx.GroupChannel.trim() } : {}),
  };
  const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
  const sessionCtx: TemplateContext = {
    ...ctx,
    SessionKey: sessionKey,
    CommandAuthorized: commandAuthorized,
    BodyStripped: bodyStripped,
    ...(normalizedChatType ? { ChatType: normalizedChatType } : {}),
  };
  return {
    sessionCtx,
    sessionEntry,
    previousSessionEntry: undefined,
    sessionStore,
    sessionKey,
    sessionId,
    isNewSession: resetTriggered || !ctx.SessionKey,
    resetTriggered,
    systemSent: false,
    abortedLastRun: false,
    storePath: cfg.session?.store?.trim() ?? "",
    sessionScope,
    groupResolution: undefined,
    isGroup,
    bodyStripped,
    triggerBodyNormalized,
  };
}
