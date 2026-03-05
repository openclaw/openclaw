import type { Client } from "@buape/carbon";
import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "../../channels/inbound-debounce-policy.js";
import { createRunStateMachine } from "../../channels/run-state-machine.js";
import { resolveOpenProviderRuntimeGroupPolicy } from "../../config/runtime-group-policy.js";
import { danger } from "../../globals.js";
import { formatDurationSeconds } from "../../infra/format-time/format-duration.ts";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import type { DiscordMessageEvent, DiscordMessageHandler } from "./listeners.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import type {
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";
import { processDiscordMessage } from "./message-handler.process.js";
import {
  hasDiscordMessageStickers,
  resolveDiscordMessageChannelId,
  resolveDiscordMessageText,
} from "./message-utils.js";
import type { DiscordMonitorStatusSink } from "./status.js";

type DiscordMessageHandlerParams = Omit<
  DiscordMessagePreflightParams,
  "ackReactionScope" | "groupPolicy" | "data" | "client"
> & {
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  listenerTimeoutMs?: number;
};

export type DiscordMessageHandlerWithLifecycle = DiscordMessageHandler & {
  deactivate: () => void;
};

const DEFAULT_DISCORD_RUN_TIMEOUT_MS = 120_000;
const MAX_DISCORD_TIMEOUT_MS = 2_147_483_647;

function normalizeDiscordRunTimeoutMs(timeoutMs?: number): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_DISCORD_RUN_TIMEOUT_MS;
  }
  return Math.max(1, Math.min(Math.floor(timeoutMs), MAX_DISCORD_TIMEOUT_MS));
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return "name" in error && String((error as { name?: unknown }).name) === "AbortError";
}

function formatDiscordRunContextSuffix(ctx: DiscordMessagePreflightContext): string {
  const eventData = ctx as {
    data?: {
      channel_id?: string;
      message?: {
        id?: string;
      };
    };
  };
  const channelId = ctx.messageChannelId?.trim() || eventData.data?.channel_id?.trim();
  const messageId = eventData.data?.message?.id?.trim();
  const details = [
    channelId ? `channelId=${channelId}` : null,
    messageId ? `messageId=${messageId}` : null,
  ].filter((entry): entry is string => Boolean(entry));
  if (details.length === 0) {
    return "";
  }
  return ` (${details.join(", ")})`;
}

function mergeAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length === 0) {
    return undefined;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(activeSignals);
  }
  const fallbackController = new AbortController();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      fallbackController.abort();
      return fallbackController.signal;
    }
  }
  const abortFallback = () => {
    fallbackController.abort();
    for (const signal of activeSignals) {
      signal.removeEventListener("abort", abortFallback);
    }
  };
  for (const signal of activeSignals) {
    signal.addEventListener("abort", abortFallback, { once: true });
  }
  return fallbackController.signal;
}

async function processDiscordRunWithTimeout(params: {
  ctx: DiscordMessagePreflightContext;
  runtime: DiscordMessagePreflightParams["runtime"];
  lifecycleSignal?: AbortSignal;
  timeoutMs?: number;
}) {
  const timeoutMs = normalizeDiscordRunTimeoutMs(params.timeoutMs);
  const timeoutAbortController = new AbortController();
  const combinedSignal = mergeAbortSignals([
    params.ctx.abortSignal,
    params.lifecycleSignal,
    timeoutAbortController.signal,
  ]);
  const processCtx =
    combinedSignal && combinedSignal !== params.ctx.abortSignal
      ? { ...params.ctx, abortSignal: combinedSignal }
      : params.ctx;
  const contextSuffix = formatDiscordRunContextSuffix(params.ctx);
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const processPromise = processDiscordMessage(processCtx).catch((error) => {
    if (timedOut) {
      if (timeoutAbortController.signal.aborted && isAbortError(error)) {
        return;
      }
      params.runtime.error?.(
        danger(`discord queued run failed after timeout: ${String(error)}${contextSuffix}`),
      );
      return;
    }
    throw error;
  });

  try {
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
      timeoutHandle.unref?.();
    });
    const result = await Promise.race([
      processPromise.then(() => "completed" as const),
      timeoutPromise,
    ]);
    if (result === "timeout") {
      timedOut = true;
      timeoutAbortController.abort();
      params.runtime.error?.(
        danger(
          `discord queued run timed out after ${formatDurationSeconds(timeoutMs, {
            decimals: 1,
            unit: "seconds",
          })}${contextSuffix}`,
        ),
      );
    }
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function resolveDiscordRunQueueKey(ctx: DiscordMessagePreflightContext): string {
  const sessionKey = ctx.route.sessionKey?.trim();
  if (sessionKey) {
    return sessionKey;
  }
  const baseSessionKey = ctx.baseSessionKey?.trim();
  if (baseSessionKey) {
    return baseSessionKey;
  }
  return ctx.messageChannelId;
}

export function createDiscordMessageHandler(
  params: DiscordMessageHandlerParams,
): DiscordMessageHandlerWithLifecycle {
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.discord !== undefined,
    groupPolicy: params.discordConfig?.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  const ackReactionScope =
    params.discordConfig?.ackReactionScope ??
    params.cfg.messages?.ackReactionScope ??
    "group-mentions";
  const runQueue = new KeyedAsyncQueue();
  const runState = createRunStateMachine({
    setStatus: params.setStatus,
    abortSignal: params.abortSignal,
  });

  const enqueueDiscordRun = (ctx: DiscordMessagePreflightContext) => {
    const queueKey = resolveDiscordRunQueueKey(ctx);
    void runQueue
      .enqueue(queueKey, async () => {
        if (!runState.isActive()) {
          return;
        }
        runState.onRunStart();
        try {
          if (!runState.isActive()) {
            return;
          }
          await processDiscordRunWithTimeout({
            ctx,
            runtime: params.runtime,
            lifecycleSignal: params.abortSignal,
            timeoutMs: params.listenerTimeoutMs,
          });
        } finally {
          runState.onRunEnd();
        }
      })
      .catch((err) => {
        params.runtime.error?.(danger(`discord process failed: ${String(err)}`));
      });
  };

  const { debouncer } = createChannelInboundDebouncer<{
    data: DiscordMessageEvent;
    client: Client;
    abortSignal?: AbortSignal;
  }>({
    cfg: params.cfg,
    channel: "discord",
    buildKey: (entry) => {
      const message = entry.data.message;
      const authorId = entry.data.author?.id;
      if (!message || !authorId) {
        return null;
      }
      const channelId = resolveDiscordMessageChannelId({
        message,
        eventChannelId: entry.data.channel_id,
      });
      if (!channelId) {
        return null;
      }
      return `discord:${params.accountId}:${channelId}:${authorId}`;
    },
    shouldDebounce: (entry) => {
      const message = entry.data.message;
      if (!message) {
        return false;
      }
      const baseText = resolveDiscordMessageText(message, { includeForwarded: false });
      return shouldDebounceTextInbound({
        text: baseText,
        cfg: params.cfg,
        hasMedia: Boolean(
          (message.attachments && message.attachments.length > 0) ||
          hasDiscordMessageStickers(message),
        ),
      });
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      const abortSignal = last.abortSignal;
      if (abortSignal?.aborted) {
        return;
      }
      if (entries.length === 1) {
        const ctx = await preflightDiscordMessage({
          ...params,
          ackReactionScope,
          groupPolicy,
          abortSignal,
          data: last.data,
          client: last.client,
        });
        if (!ctx) {
          return;
        }
        enqueueDiscordRun(ctx);
        return;
      }
      const combinedBaseText = entries
        .map((entry) => resolveDiscordMessageText(entry.data.message, { includeForwarded: false }))
        .filter(Boolean)
        .join("\n");
      const syntheticMessage = {
        ...last.data.message,
        content: combinedBaseText,
        attachments: [],
        message_snapshots: (last.data.message as { message_snapshots?: unknown }).message_snapshots,
        messageSnapshots: (last.data.message as { messageSnapshots?: unknown }).messageSnapshots,
        rawData: {
          ...(last.data.message as { rawData?: Record<string, unknown> }).rawData,
        },
      };
      const syntheticData: DiscordMessageEvent = {
        ...last.data,
        message: syntheticMessage,
      };
      const ctx = await preflightDiscordMessage({
        ...params,
        ackReactionScope,
        groupPolicy,
        abortSignal,
        data: syntheticData,
        client: last.client,
      });
      if (!ctx) {
        return;
      }
      if (entries.length > 1) {
        const ids = entries.map((entry) => entry.data.message?.id).filter(Boolean) as string[];
        if (ids.length > 0) {
          const ctxBatch = ctx as typeof ctx & {
            MessageSids?: string[];
            MessageSidFirst?: string;
            MessageSidLast?: string;
          };
          ctxBatch.MessageSids = ids;
          ctxBatch.MessageSidFirst = ids[0];
          ctxBatch.MessageSidLast = ids[ids.length - 1];
        }
      }
      enqueueDiscordRun(ctx);
    },
    onError: (err) => {
      params.runtime.error?.(danger(`discord debounce flush failed: ${String(err)}`));
    },
  });

  const handler: DiscordMessageHandlerWithLifecycle = async (data, client, options) => {
    try {
      if (options?.abortSignal?.aborted) {
        return;
      }
      // Filter bot-own messages before they enter the debounce queue.
      // The same check exists in preflightDiscordMessage(), but by that point
      // the message has already consumed debounce capacity and blocked
      // legitimate user messages. On active servers this causes cumulative
      // slowdown (see #15874).
      const msgAuthorId = data.message?.author?.id ?? data.author?.id;
      if (params.botUserId && msgAuthorId === params.botUserId) {
        return;
      }

      await debouncer.enqueue({ data, client, abortSignal: options?.abortSignal });
    } catch (err) {
      params.runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  };

  handler.deactivate = runState.deactivate;

  return handler;
}
