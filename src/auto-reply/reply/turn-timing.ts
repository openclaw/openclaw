import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { ReplyDispatcherOptions } from "./reply-dispatcher.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";

export const TURN_TIMING_SCHEMA_VERSION = "openclaw.turn_timing.v1";

export type TurnTimingFailureClass =
  | "auth_refresh"
  | "bootstrap"
  | "gateway_restart"
  | "model_routing"
  | "provider_api"
  | "telegram_send"
  | "unknown";

export type TurnTimingRuntimeFamily =
  | "codex-subscription"
  | "direct-openai-api"
  | "provider-runtime";

export type TurnTimingContext = {
  correlationId: string;
  startedAtMs: number;
  channel: "telegram";
  sessionKey?: string;
  messageId?: string;
  chatType?: string;
  firstOutputLogged: boolean;
};

type TurnTimingEventFields = {
  phase:
    | "telegram.update_received"
    | "gateway.dispatch_start"
    | "gateway.dispatch_complete"
    | "gateway.dispatch_error"
    | "runtime.route_selected"
    | "runtime.request_start"
    | "runtime.request_complete"
    | "runtime.request_error"
    | "reply.first_output"
    | "reply.final_output"
    | "telegram.send_start"
    | "telegram.send_complete"
    | "telegram.send_error";
  durationMs?: number;
  outcome?: "completed" | "error" | "skipped";
  provider?: string;
  model?: string;
  runtime?: string;
  runtimeSource?: string;
  runtimeFamily?: TurnTimingRuntimeFamily;
  requestProvider?: string;
  retryCount?: number;
  attemptIndex?: number;
  replyKind?: ReplyDispatchKind | "partial";
  payloadTextChars?: number;
  payloadMediaCount?: number;
  payloadIsError?: boolean;
  replyQueuedCount?: number;
  replyFailedCount?: number;
  replyCancelledCount?: number;
  failureClass?: TurnTimingFailureClass;
  errorName?: string;
};

const log = createSubsystemLogger("auto-reply/turn-timing");
const turnTimingContextKey = Symbol.for("openclaw.turnTimingContext");

type TurnTimingAttachedReplyOptions = Omit<GetReplyOptions, "onBlockReply"> & {
  [turnTimingContextKey]?: TurnTimingContext;
};

type TurnTimingMessageContext = Pick<
  FinalizedMsgContext,
  | "Provider"
  | "Surface"
  | "SessionKey"
  | "CommandTargetSessionKey"
  | "MessageSid"
  | "MessageSidFirst"
  | "MessageSidFull"
  | "MessageSidLast"
  | "ChatType"
>;

function resolveChannel(ctx: TurnTimingMessageContext): string {
  return normalizeLowercaseStringOrEmpty(ctx.Surface ?? ctx.Provider ?? "");
}

export function isTelegramTurnContext(ctx: TurnTimingMessageContext): boolean {
  return resolveChannel(ctx) === "telegram";
}

function resolveMessageId(ctx: TurnTimingMessageContext): string | undefined {
  return normalizeOptionalString(
    ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast,
  );
}

export function createTelegramTurnTimingContext(params: {
  ctx: TurnTimingMessageContext;
  runId?: string;
}): TurnTimingContext | undefined {
  if (!isTelegramTurnContext(params.ctx)) {
    return undefined;
  }
  return {
    correlationId: normalizeOptionalString(params.runId) ?? `telegram-turn-${randomUUID()}`,
    startedAtMs: performance.now(),
    channel: "telegram",
    sessionKey: normalizeOptionalString(
      params.ctx.CommandTargetSessionKey ?? params.ctx.SessionKey,
    ),
    messageId: resolveMessageId(params.ctx),
    chatType: normalizeOptionalString(params.ctx.ChatType),
    firstOutputLogged: false,
  };
}

function normalizeDurationMs(startedAtMs: number): number {
  return Math.max(0, Math.round((performance.now() - startedAtMs) * 1000) / 1000);
}

export function measureTurnTimingDurationMs(startedAtMs: number): number {
  return normalizeDurationMs(startedAtMs);
}

function readErrorName(error: unknown): string | undefined {
  if (error && typeof error === "object" && "name" in error) {
    return normalizeOptionalString(String((error as { name?: unknown }).name));
  }
  return undefined;
}

function readErrorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error ?? "");
}

export function classifyTurnTimingFailure(
  error: unknown,
  hint?: "telegram_send",
): TurnTimingFailureClass {
  if (hint === "telegram_send") {
    return "telegram_send";
  }
  const message = readErrorText(error).toLowerCase();
  if (
    /(refresh[_ -]?token|token[_ -]?invalidated|auth[_ -]?block|oauth|login expired|reauth)/u.test(
      message,
    )
  ) {
    return "auth_refresh";
  }
  if (
    /\b(gateway.*restart|gateway.*draining|command lane cleared|commandlanecleared)\b/u.test(
      message,
    )
  ) {
    return "gateway_restart";
  }
  if (
    /\b(bootstrap|provider-?id|temporal dead zone|cannot access .+ before initialization|preflight compaction)\b/u.test(
      message,
    )
  ) {
    return "bootstrap";
  }
  if (
    /\b(model routing|route selected|unknown provider|provider .+ not configured|no model|missing model|no api key found|missing api key)\b/u.test(
      message,
    )
  ) {
    return "model_routing";
  }
  if (
    /\b(provider api|rate limit|overloaded|billing|http\s*[45]\d\d|status\s*[45]\d\d|api request)\b/u.test(
      message,
    )
  ) {
    return "provider_api";
  }
  return "unknown";
}

export function resolveTurnTimingRuntimeFamily(params: {
  provider?: string;
  runtime?: string;
  requestProvider?: string;
}): TurnTimingRuntimeFamily {
  const provider = normalizeLowercaseStringOrEmpty(params.provider);
  const runtime = normalizeLowercaseStringOrEmpty(params.runtime);
  const requestProvider = normalizeLowercaseStringOrEmpty(params.requestProvider);
  if (runtime === "codex" || provider === "openai-codex" || requestProvider === "openai-codex") {
    return "codex-subscription";
  }
  return provider === "openai" || requestProvider === "openai"
    ? "direct-openai-api"
    : "provider-runtime";
}

function payloadSummary(
  payload: ReplyPayload,
): Pick<TurnTimingEventFields, "payloadTextChars" | "payloadMediaCount" | "payloadIsError"> {
  const text = normalizeOptionalString(payload.text);
  return {
    payloadTextChars: text?.length ?? 0,
    payloadMediaCount: Array.isArray(payload.mediaUrls) ? payload.mediaUrls.length : 0,
    payloadIsError: payload.isError === true,
  };
}

export function emitTurnTimingEvent(
  timing: TurnTimingContext | undefined,
  fields: TurnTimingEventFields,
): void {
  if (!timing) {
    return;
  }
  log.info("turn_timing", {
    schemaVersion: TURN_TIMING_SCHEMA_VERSION,
    correlationId: timing.correlationId,
    channel: timing.channel,
    sessionKey: timing.sessionKey,
    messageId: timing.messageId,
    chatType: timing.chatType,
    elapsedMs: normalizeDurationMs(timing.startedAtMs),
    ...fields,
    consoleMessage:
      `turn_timing phase=${fields.phase} correlationId=${timing.correlationId}` +
      (fields.runtimeFamily ? ` runtimeFamily=${fields.runtimeFamily}` : "") +
      (fields.durationMs !== undefined ? ` durationMs=${fields.durationMs}` : "") +
      (fields.failureClass ? ` failureClass=${fields.failureClass}` : ""),
  });
}

function emitFirstOutputIfNeeded(
  timing: TurnTimingContext | undefined,
  fields: Omit<TurnTimingEventFields, "phase">,
): void {
  if (!timing || timing.firstOutputLogged) {
    return;
  }
  timing.firstOutputLogged = true;
  emitTurnTimingEvent(timing, { phase: "reply.first_output", ...fields });
}

export function getTurnTimingContextFromReplyOptions(
  options: Omit<GetReplyOptions, "onBlockReply"> | undefined,
): TurnTimingContext | undefined {
  return (options as TurnTimingAttachedReplyOptions | undefined)?.[turnTimingContextKey];
}

export function wrapTurnTimingReplyOptions(
  timing: TurnTimingContext | undefined,
  options: Omit<GetReplyOptions, "onBlockReply"> | undefined,
): TurnTimingAttachedReplyOptions | undefined {
  if (!timing) {
    return options;
  }
  const base: Omit<GetReplyOptions, "onBlockReply"> = options ?? {};
  return {
    ...base,
    [turnTimingContextKey]: timing,
    runId: timing.correlationId,
    onPartialReply: async (
      payload: Parameters<NonNullable<GetReplyOptions["onPartialReply"]>>[0],
    ) => {
      emitFirstOutputIfNeeded(timing, {
        replyKind: "partial",
        payloadTextChars: normalizeOptionalString(payload.text)?.length ?? 0,
        payloadMediaCount: Array.isArray(payload.mediaUrls) ? payload.mediaUrls.length : 0,
      });
      await base.onPartialReply?.(payload);
    },
  };
}

export function wrapTurnTimingDispatcherOptions<T extends Pick<ReplyDispatcherOptions, "deliver">>(
  timing: TurnTimingContext | undefined,
  options: T,
): T {
  if (!timing) {
    return options;
  }
  return {
    ...options,
    deliver: async (payload, info) => {
      emitFirstOutputIfNeeded(timing, {
        replyKind: info.kind,
        ...payloadSummary(payload),
      });
      if (info.kind === "final") {
        emitTurnTimingEvent(timing, {
          phase: "reply.final_output",
          replyKind: info.kind,
          ...payloadSummary(payload),
        });
      }
      const startedAtMs = performance.now();
      emitTurnTimingEvent(timing, {
        phase: "telegram.send_start",
        replyKind: info.kind,
      });
      try {
        const result = await options.deliver(payload, info);
        emitTurnTimingEvent(timing, {
          phase: "telegram.send_complete",
          replyKind: info.kind,
          durationMs: normalizeDurationMs(startedAtMs),
        });
        return result;
      } catch (error) {
        emitTurnTimingEvent(timing, {
          phase: "telegram.send_error",
          replyKind: info.kind,
          durationMs: normalizeDurationMs(startedAtMs),
          failureClass: classifyTurnTimingFailure(error, "telegram_send"),
          errorName: readErrorName(error),
        });
        throw error;
      }
    },
  };
}
