import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import { resolveModelRefFromString, type ModelRef } from "../agents/model-selection.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import {
  resolveHeartbeatPromptCore as resolveHeartbeatPromptText,
  resolveHeartbeatPromptForResponseTool,
} from "../auto-reply/heartbeat.js";
import { resolveDefaultModel } from "../auto-reply/reply/directive-handling.defaults.js";
import { normalizeChatType, type ChatType } from "../channels/chat-type.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import type { ChannelId, ChannelPlugin } from "../channels/plugins/types.public.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActivePluginChannelRegistry } from "../plugins/runtime.js";
import type { HeartbeatConfig } from "./heartbeat-config.js";

export function resolveHeartbeatChannelPlugin(channel: string): ChannelPlugin | undefined {
  const activePlugin = getActivePluginChannelRegistry()?.channels.find(
    (entry) => entry.plugin.id === channel,
  )?.plugin;
  return activePlugin ?? getChannelPlugin(channel as ChannelId);
}

function resolveHeartbeatPromptRaw(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig) {
  return heartbeat?.prompt ?? cfg.agents?.defaults?.heartbeat?.prompt;
}

export function resolveConfiguredHeartbeatPrompt(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig) {
  return resolveHeartbeatPromptText(resolveHeartbeatPromptRaw(cfg, heartbeat));
}

export function resolveHeartbeatResponseToolPrompt(
  cfg: OpenClawConfig,
  heartbeat?: HeartbeatConfig,
) {
  return resolveHeartbeatPromptForResponseTool(resolveHeartbeatPromptRaw(cfg, heartbeat));
}

function resolveHeartbeatModelRef(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  entry?: SessionEntry;
}): ModelRef {
  const { defaultProvider, defaultModel, aliasIndex } = resolveDefaultModel({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const heartbeatRaw =
    normalizeOptionalString(params.heartbeat?.model) ??
    normalizeOptionalString(params.cfg.agents?.defaults?.heartbeat?.model) ??
    "";
  const heartbeatRef = heartbeatRaw
    ? resolveModelRefFromString({
        raw: heartbeatRaw,
        defaultProvider,
        aliasIndex,
      })?.ref
    : undefined;
  if (heartbeatRef) {
    return heartbeatRef;
  }
  return {
    provider:
      normalizeOptionalString(params.entry?.providerOverride) ??
      normalizeOptionalString(params.entry?.modelProvider) ??
      defaultProvider,
    model:
      normalizeOptionalString(params.entry?.modelOverride) ??
      normalizeOptionalString(params.entry?.model) ??
      defaultModel,
  };
}

function usesCodexHarness(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  entry?: SessionEntry;
  sessionKey?: string;
}): boolean {
  const modelRef = resolveHeartbeatModelRef(params);
  return (
    resolveEffectiveAgentRuntime({
      cfg: params.cfg,
      provider: modelRef.provider,
      modelId: modelRef.model,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionEntry: params.entry,
    }) === "codex"
  );
}

export function shouldUseHeartbeatResponseToolPrompt(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  entry?: SessionEntry;
  sessionKey?: string;
  chatType?: ChatType;
}): boolean {
  const chatType = normalizeChatType(params.chatType);
  const visibleReplies =
    chatType === "group" || chatType === "channel"
      ? (params.cfg.messages?.groupChat?.visibleReplies ?? params.cfg.messages?.visibleReplies)
      : params.cfg.messages?.visibleReplies;
  if (visibleReplies === "message_tool") {
    return true;
  }
  if (visibleReplies === "automatic") {
    return false;
  }
  return usesCodexHarness(params);
}

export function isHeartbeatTypingEnabled(params: {
  cfg: OpenClawConfig;
  agentId: string;
  hasChatDelivery: boolean;
}) {
  if (!params.hasChatDelivery) {
    return false;
  }
  const typingMode =
    resolveAgentConfig(params.cfg, params.agentId)?.typingMode ??
    params.cfg.agents?.defaults?.typingMode;
  return typingMode !== "never";
}

export function resolveHeartbeatTypingIntervalSeconds(cfg: OpenClawConfig) {
  const configured = cfg.agents?.defaults?.typingIntervalSeconds;
  return typeof configured === "number" && configured > 0 ? configured : undefined;
}
