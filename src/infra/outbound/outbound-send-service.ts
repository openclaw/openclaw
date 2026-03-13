import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-actions.js";
import type { ChannelId, ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import type { GatewayClientMode, GatewayClientName } from "../../utils/message-channel.js";
import { throwIfAborted } from "./abort.js";
import type { OutboundSendDeps } from "./deliver.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
import { sendMessage, sendPoll } from "./message.js";
import { extractToolPayload } from "./tool-payload.js";

export type OutboundGatewayContext = {
  url?: string;
  token?: string;
  timeoutMs?: number;
  clientName: GatewayClientName;
  clientDisplayName?: string;
  mode: GatewayClientMode;
};

export type OutboundSendContext = {
  cfg: OpenClawConfig;
  channel: ChannelId;
  params: Record<string, unknown>;
  /** Active agent id for per-agent outbound media root scoping. */
  agentId?: string;
  accountId?: string | null;
  gateway?: OutboundGatewayContext;
  toolContext?: ChannelThreadingToolContext;
  deps?: OutboundSendDeps;
  dryRun: boolean;
  mirror?: {
    sessionKey: string;
    agentId?: string;
    text?: string;
    mediaUrls?: string[];
  };
  abortSignal?: AbortSignal;
  silent?: boolean;
};

type PluginHandledResult = {
  handledBy: "plugin";
  payload: unknown;
  toolResult: AgentToolResult<unknown>;
};

class OutboundCircuitBreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundCircuitBreakerError";
  }
}

type OutboundSendWindow = {
  windowStartedAt: number;
  sentCount: number;
  lastFingerprint?: string;
  lastSentAt?: number;
  consecutiveDuplicateCount: number;
};

const OUTBOUND_CIRCUIT_WINDOW_MS = 3 * 60_000;
const OUTBOUND_CIRCUIT_MAX_SENT_PER_WINDOW = 20;
const OUTBOUND_CIRCUIT_MAX_CONSECUTIVE_DUPLICATES = 3;

const outboundCircuitBreaker = new Map<string, OutboundSendWindow>();

const OUTBOUND_CIRCUIT_EVICT_AFTER_MS = OUTBOUND_CIRCUIT_WINDOW_MS * 2;
const OUTBOUND_CIRCUIT_SWEEP_EVERY_N_CALLS = 100;
let outboundCircuitBreakerSweepBudget = 0;

export function __resetOutboundCircuitBreakerForTest() {
  outboundCircuitBreaker.clear();
  outboundCircuitBreakerSweepBudget = 0;
}

function maybeSweepOutboundCircuitBreaker(now: number) {
  outboundCircuitBreakerSweepBudget += 1;
  if (outboundCircuitBreakerSweepBudget < OUTBOUND_CIRCUIT_SWEEP_EVERY_N_CALLS) {
    return;
  }
  outboundCircuitBreakerSweepBudget = 0;

  for (const [key, value] of outboundCircuitBreaker.entries()) {
    if (!value.lastSentAt) {
      outboundCircuitBreaker.delete(key);
      continue;
    }
    if (now - value.lastSentAt > OUTBOUND_CIRCUIT_EVICT_AFTER_MS) {
      outboundCircuitBreaker.delete(key);
    }
  }
}

function fingerprintOutboundSend(params: {
  message: string;
  mediaUrls?: string[];
  replyToId?: string;
  gifPlayback?: boolean;
  pluginParams?: unknown;
}): string {
  const payload = JSON.stringify({
    message: params.message,
    mediaUrls: params.mediaUrls ?? [],
    replyToId: params.replyToId ?? null,
    gifPlayback: params.gifPlayback ?? false,
    // Include any plugin-specific parameters so that sends differing only in
    // plugin params (e.g. effects, sticker ids) are not collapsed as duplicates.
    pluginParams: params.pluginParams ?? null,
  });
  return crypto.createHash("sha1").update(payload).digest("hex");
}

function maybeTripOutboundCircuitBreaker(params: {
  key: string;
  fingerprint: string;
  now: number;
}): void {
  maybeSweepOutboundCircuitBreaker(params.now);

  const existing = outboundCircuitBreaker.get(params.key);

  // Evict stale entries eagerly to prevent unbounded growth.
  if (existing?.lastSentAt && params.now - existing.lastSentAt > OUTBOUND_CIRCUIT_EVICT_AFTER_MS) {
    outboundCircuitBreaker.delete(params.key);
  }

  const base = outboundCircuitBreaker.get(params.key);
  const next: OutboundSendWindow = base
    ? { ...base }
    : {
        windowStartedAt: params.now,
        sentCount: 0,
        consecutiveDuplicateCount: 0,
      };

  // Reset state when leaving the active window.
  if (params.now - next.windowStartedAt >= OUTBOUND_CIRCUIT_WINDOW_MS) {
    next.windowStartedAt = params.now;
    next.sentCount = 0;
    next.lastFingerprint = undefined;
    next.lastSentAt = undefined;
    next.consecutiveDuplicateCount = 0;
  }

  // If already tripped within the active window, fail fast without inflating counts.
  if (next.sentCount > OUTBOUND_CIRCUIT_MAX_SENT_PER_WINDOW) {
    throw new OutboundCircuitBreakerError(
      `Outbound circuit breaker tripped: sent ${next.sentCount} messages within ${
        OUTBOUND_CIRCUIT_WINDOW_MS / 1000
      }s for key ${params.key}`,
    );
  }

  if (next.consecutiveDuplicateCount > OUTBOUND_CIRCUIT_MAX_CONSECUTIVE_DUPLICATES) {
    throw new OutboundCircuitBreakerError(
      `Outbound circuit breaker tripped: detected ${next.consecutiveDuplicateCount} consecutive duplicate messages within ${
        OUTBOUND_CIRCUIT_WINDOW_MS / 1000
      }s for key ${params.key}`,
    );
  }

  next.sentCount += 1;

  const isDuplicate = next.lastFingerprint === params.fingerprint;
  if (isDuplicate) {
    next.consecutiveDuplicateCount += 1;
  } else {
    next.consecutiveDuplicateCount = 1;
  }

  next.lastFingerprint = params.fingerprint;
  next.lastSentAt = params.now;

  outboundCircuitBreaker.set(params.key, next);

  if (next.sentCount > OUTBOUND_CIRCUIT_MAX_SENT_PER_WINDOW) {
    throw new OutboundCircuitBreakerError(
      `Outbound circuit breaker tripped: sent ${next.sentCount} messages within ${
        OUTBOUND_CIRCUIT_WINDOW_MS / 1000
      }s for key ${params.key}`,
    );
  }

  if (next.consecutiveDuplicateCount > OUTBOUND_CIRCUIT_MAX_CONSECUTIVE_DUPLICATES) {
    throw new OutboundCircuitBreakerError(
      `Outbound circuit breaker tripped: detected ${next.consecutiveDuplicateCount} consecutive duplicate messages within ${
        OUTBOUND_CIRCUIT_WINDOW_MS / 1000
      }s for key ${params.key}`,
    );
  }
}

async function tryHandleWithPluginAction(params: {
  ctx: OutboundSendContext;
  action: "send" | "poll";
  onHandled?: () => Promise<void> | void;
}): Promise<PluginHandledResult | null> {
  if (params.ctx.dryRun) {
    return null;
  }
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(
    params.ctx.cfg,
    params.ctx.agentId ?? params.ctx.mirror?.agentId,
  );
  const handled = await dispatchChannelMessageAction({
    channel: params.ctx.channel,
    action: params.action,
    cfg: params.ctx.cfg,
    params: params.ctx.params,
    mediaLocalRoots,
    accountId: params.ctx.accountId ?? undefined,
    gateway: params.ctx.gateway,
    toolContext: params.ctx.toolContext,
    dryRun: params.ctx.dryRun,
  });
  if (!handled) {
    return null;
  }
  await params.onHandled?.();
  return {
    handledBy: "plugin",
    payload: extractToolPayload(handled),
    toolResult: handled,
  };
}

export async function executeSendAction(params: {
  ctx: OutboundSendContext;
  to: string;
  message: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  gifPlayback?: boolean;
  bestEffort?: boolean;
  replyToId?: string;
  threadId?: string | number;
}): Promise<{
  handledBy: "plugin" | "core";
  payload: unknown;
  toolResult?: AgentToolResult<unknown>;
  sendResult?: MessageSendResult;
}> {
  throwIfAborted(params.ctx.abortSignal);

  if (!params.ctx.dryRun) {
    const sessionKeyHint =
      (params.ctx.params as { __sessionKey?: string }).__sessionKey ??
      params.ctx.mirror?.sessionKey ??
      "global";
    const threadKey = params.threadId == null ? "" : String(params.threadId);
    const breakerKey = `${sessionKeyHint}:${params.ctx.channel}:${params.to}:${threadKey}`;
    const fingerprint = fingerprintOutboundSend({
      message: params.message.trim(),
      mediaUrls: params.mediaUrls ?? (params.mediaUrl ? [params.mediaUrl] : undefined),
      replyToId: params.replyToId,
      gifPlayback: params.gifPlayback,
      pluginParams: (params.ctx.params as { pluginParams?: unknown }).pluginParams,
    });
    maybeTripOutboundCircuitBreaker({
      key: breakerKey,
      fingerprint,
      now: Date.now(),
    });
  }

  const pluginHandled = await tryHandleWithPluginAction({
    ctx: params.ctx,
    action: "send",
    onHandled: async () => {
      if (!params.ctx.mirror) {
        return;
      }
      const mirrorText = params.ctx.mirror.text ?? params.message;
      const mirrorMediaUrls =
        params.ctx.mirror.mediaUrls ??
        params.mediaUrls ??
        (params.mediaUrl ? [params.mediaUrl] : undefined);
      await appendAssistantMessageToSessionTranscript({
        agentId: params.ctx.mirror.agentId,
        sessionKey: params.ctx.mirror.sessionKey,
        text: mirrorText,
        mediaUrls: mirrorMediaUrls,
      });
    },
  });
  if (pluginHandled) {
    return pluginHandled;
  }

  throwIfAborted(params.ctx.abortSignal);
  const result: MessageSendResult = await sendMessage({
    cfg: params.ctx.cfg,
    to: params.to,
    content: params.message,
    agentId: params.ctx.agentId,
    mediaUrl: params.mediaUrl || undefined,
    mediaUrls: params.mediaUrls,
    channel: params.ctx.channel || undefined,
    accountId: params.ctx.accountId ?? undefined,
    replyToId: params.replyToId,
    threadId: params.threadId,
    gifPlayback: params.gifPlayback,
    dryRun: params.ctx.dryRun,
    bestEffort: params.bestEffort ?? undefined,
    deps: params.ctx.deps,
    gateway: params.ctx.gateway,
    mirror: params.ctx.mirror,
    abortSignal: params.ctx.abortSignal,
    silent: params.ctx.silent,
  });

  return {
    handledBy: "core",
    payload: result,
    sendResult: result,
  };
}

export async function executePollAction(params: {
  ctx: OutboundSendContext;
  to: string;
  question: string;
  options: string[];
  maxSelections: number;
  durationSeconds?: number;
  durationHours?: number;
  threadId?: string;
  isAnonymous?: boolean;
}): Promise<{
  handledBy: "plugin" | "core";
  payload: unknown;
  toolResult?: AgentToolResult<unknown>;
  pollResult?: MessagePollResult;
}> {
  const pluginHandled = await tryHandleWithPluginAction({
    ctx: params.ctx,
    action: "poll",
  });
  if (pluginHandled) {
    return pluginHandled;
  }

  const result: MessagePollResult = await sendPoll({
    cfg: params.ctx.cfg,
    to: params.to,
    question: params.question,
    options: params.options,
    maxSelections: params.maxSelections,
    durationSeconds: params.durationSeconds ?? undefined,
    durationHours: params.durationHours ?? undefined,
    channel: params.ctx.channel,
    accountId: params.ctx.accountId ?? undefined,
    threadId: params.threadId ?? undefined,
    silent: params.ctx.silent ?? undefined,
    isAnonymous: params.isAnonymous ?? undefined,
    dryRun: params.ctx.dryRun,
    gateway: params.ctx.gateway,
  });

  return {
    handledBy: "core",
    payload: result,
    pollResult: result,
  };
}
