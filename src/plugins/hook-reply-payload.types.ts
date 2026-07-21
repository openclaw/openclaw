import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { ReplyDispatchKind } from "../auto-reply/reply/reply-dispatcher.types.js";
import type { PluginHookMessageContext } from "./hook-message.types.js";

/** Plugin-visible reply payload with core trust metadata removed. */
export type PluginHookReplyPayload = Omit<ReplyPayload, "trustedLocalMedia">;

/** Per-turn execution state available to outbound reply hooks. */
export type PluginHookReplyUsageState = {
  provider?: string;
  model?: string;
  resolvedRef?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  fallbackUsed?: boolean;
  agentId?: string;
  sessionId?: string;
  chatType?: string;
  authMode?: string;
  overrideSource?: string;
  requested?: string;
  turnUsd?: number;
  durationMs?: number;
  identity?: { name?: string; emoji?: string; avatar?: string };
  compactionCount?: number;
  contextTokenBudget?: number;
  /** Final model-call prompt occupancy, rather than aggregate tool-loop usage. */
  contextUsedTokens?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  /** Usage from only the final model call of the turn. */
  lastUsage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

export type PluginHookReplyPayloadSendingEvent = {
  payload: PluginHookReplyPayload;
  kind: ReplyDispatchKind;
  channel?: string;
  sessionKey?: string;
  runId?: string;
  /** Exact per-turn state; absent on uncorrelated durable delivery. */
  usageState?: PluginHookReplyUsageState;
};

export type PluginHookReplyPayloadSendingContext = PluginHookMessageContext;

export type PluginHookReplyPayloadSendingResult = {
  payload?: PluginHookReplyPayload;
  cancel?: boolean;
  reason?: string;
};
