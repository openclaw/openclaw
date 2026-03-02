import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import { createOutboundSendDeps } from "../../cli/deps.js";
import { loadConfig } from "../../config/config.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../../infra/outbound/outbound-session.js";
import { normalizeReplyPayloadsForDelivery } from "../../infra/outbound/payloads.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";
import { normalizePollInput } from "../../polls.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validatePollParams,
  validateSendParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

type InflightResult = {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: ReturnType<typeof errorShape>;
  meta?: Record<string, unknown>;
};

const inflightByContext = new WeakMap<
  GatewayRequestContext,
  Map<string, Promise<InflightResult>>
>();

const getInflightMap = (context: GatewayRequestContext) => {
  let inflight = inflightByContext.get(context);
  if (!inflight) {
    inflight = new Map();
    inflightByContext.set(context, inflight);
  }
  return inflight;
};

async function resolveRequestedChannel(params: {
  requestChannel: unknown;
  unsupportedMessage: (input: string) => string;
  rejectWebchatAsInternalOnly?: boolean;
}): Promise<
  | {
      cfg: ReturnType<typeof loadConfig>;
      channel: string;
    }
  | {
      error: ReturnType<typeof errorShape>;
    }
> {
  const channelInput =
    typeof params.requestChannel === "string" ? params.requestChannel : undefined;
  const normalizedChannel = channelInput ? normalizeChannelId(channelInput) : null;
  if (channelInput && !normalizedChannel) {
    const normalizedInput = channelInput.trim().toLowerCase();
    if (params.rejectWebchatAsInternalOnly && normalizedInput === "webchat") {
      return {
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          "unsupported channel: webchat (internal-only). Use `chat.send` for WebChat UI messages or choose a deliverable channel.",
        ),
      };
    }
    return {
      error: errorShape(ErrorCodes.INVALID_REQUEST, params.unsupportedMessage(channelInput)),
    };
  }
  const cfg = loadConfig();
  let channel = normalizedChannel;
  if (!channel) {
    try {
      channel = (await resolveMessageChannelSelection({ cfg })).channel;
    } catch (err) {
      return { error: errorShape(ErrorCodes.INVALID_REQUEST, String(err)) };
    }
  }
  return { cfg, channel };
}

export const sendHandlers: GatewayRequestHandlers = {
  send: async ({ params, respond, context }) => {
    const p = params;
    if (!validateSendParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid send params: ${formatValidationErrors(validateSendParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      to: string;
      message?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      gifPlayback?: boolean;
      channel?: string;
      accountId?: string;
      agentId?: string;
      threadId?: string;
      sessionKey?: string;
      idempotencyKey: string;
    };
    const idem = request.idempotencyKey;
    const dedupeKey = `send:${idem}`;
    const cached = context.dedupe.get(dedupeKey);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }
    const inflightMap = getInflightMap(context);
    const inflight = inflightMap.get(dedupeKey);
    if (inflight) {
      const result = await inflight;
      const meta = result.meta ? { ...result.meta, cached: true } : { cached: true };
      respond(result.ok, result.payload, result.error, meta);
      return;
    }
    const to = request.to.trim();
    const message = typeof request.message === "string" ? request.message.trim() : "";
    const mediaUrl =
      typeof request.mediaUrl === "string" && request.mediaUrl.trim().length > 0
        ? request.mediaUrl.trim()
        : undefined;
    const mediaUrls = Array.isArray(request.mediaUrls)
      ? request.mediaUrls
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter((entry) => entry.length > 0)
      : undefined;
    if (!message && !mediaUrl && (mediaUrls?.length ?? 0) === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid send params: text or media is required"),
      );
      return;
    }
    const resolvedChannel = await resolveRequestedChannel({
      requestChannel: request.channel,
      unsupportedMessage: (input) => `unsupported channel: ${input}`,
      rejectWebchatAsInternalOnly: true,
    });
    if ("error" in resolvedChannel) {
      respond(false, undefined, resolvedChannel.error);
      return;
    }
    const { cfg, channel } = resolvedChannel;
    const accountId =
      typeof request.accountId === "string" && request.accountId.trim().length
        ? request.accountId.trim()
        : undefined;
    const threadId =
      typeof request.threadId === "string" && request.threadId.trim().length
        ? request.threadId.trim()
        : undefined;
    const outboundChannel = channel;
    const plugin = resolveOutboundChannelPlugin({ channel, cfg });
    if (!plugin) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unsupported channel: ${channel}`),
      );
      return;
    }

    const work = (async (): Promise<InflightResult> => {
      try {
        const resolved = resolveOutboundTarget({
          channel: outboundChannel,
          to,
          cfg,
          accountId,
          mode: "explicit",
        });
        if (!resolved.ok) {
          return {
            ok: false,
            error: errorShape(ErrorCodes.INVALID_REQUEST, String(resolved.error)),
            meta: { channel },
          };
        }
        const outboundDeps = context.deps ? createOutboundSendDeps(context.deps) : undefined;
        const mirrorPayloads = normalizeReplyPayloadsForDelivery([
          { text: message, mediaUrl, mediaUrls },
        ]);
        const mirrorText = mirrorPayloads
          .map((payload) => payload.text)
          .filter(Boolean)
          .join("\n");
        const mirrorMediaUrls = mirrorPayloads.flatMap(
          (payload) => payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []),
        );
        const providedSessionKey =
          typeof request.sessionKey === "string" && request.sessionKey.trim()
            ? request.sessionKey.trim().toLowerCase()
            : undefined;
        const explicitAgentId =
          typeof request.agentId === "string" && request.agentId.trim()
            ? request.agentId.trim()
            : undefined;
        const sessionAgentId = providedSessionKey
          ? resolveSessionAgentId({ sessionKey: providedSessionKey, config: cfg })
          : undefined;
        const defaultAgentId = resolveSessionAgentId({ config: cfg });
        const effectiveAgentId = explicitAgentId ?? sessionAgentId ?? defaultAgentId;
        // If callers omit sessionKey, derive a target session key from the outbound route.
        const derivedRoute = !providedSessionKey
          ? await resolveOutboundSessionRoute({
              cfg,
              channel,
              agentId: effectiveAgentId,
              accountId,
              target: resolved.to,
              threadId,
            })
          : null;
        if (derivedRoute) {
          await ensureOutboundSessionEntry({
            cfg,
            agentId: effectiveAgentId,
            channel,
            accountId,
            route: derivedRoute,
          });
        }
        const outboundSession = buildOutboundSessionContext({
          cfg,
          agentId: effectiveAgentId,
          sessionKey: providedSessionKey ?? derivedRoute?.sessionKey,
        });
        const results = await deliverOutboundPayloads({
          cfg,
          channel: outboundChannel,
          to: resolved.to,
          accountId,
          payloads: [{ text: message, mediaUrl, mediaUrls }],
          session: outboundSession,
          gifPlayback: request.gifPlayback,
          threadId: threadId ?? null,
          deps: outboundDeps,
          mirror: providedSessionKey
            ? {
                sessionKey: providedSessionKey,
                agentId: effectiveAgentId,
                text: mirrorText || message,
                mediaUrls: mirrorMediaUrls.length > 0 ? mirrorMediaUrls : undefined,
              }
            : derivedRoute
              ? {
                  sessionKey: derivedRoute.sessionKey,
                  agentId: effectiveAgentId,
                  text: mirrorText || message,
                  mediaUrls: mirrorMediaUrls.length > 0 ? mirrorMediaUrls : undefined,
                }
              : undefined,
        });

        const result = results.at(-1);
        if (!result) {
          throw new Error("No delivery result");
        }
        const payload: Record<string, unknown> = {
          runId: idem,
          messageId: result.messageId,
          channel,
        };
        if ("chatId" in result) {
          payload.chatId = result.chatId;
        }
        if ("channelId" in result) {
          payload.channelId = result.channelId;
        }
        if ("toJid" in result) {
          payload.toJid = result.toJid;
        }
        if ("conversationId" in result) {
          payload.conversationId = result.conversationId;
        }
        context.dedupe.set(dedupeKey, {
          ts: Date.now(),
          ok: true,
          payload,
        });
        return {
          ok: true,
          payload,
          meta: { channel },
        };
      } catch (err) {
        const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
        context.dedupe.set(dedupeKey, {
          ts: Date.now(),
          ok: false,
          error,
        });
        return { ok: false, error, meta: { channel, error: formatForLog(err) } };
      }
    })();

    inflightMap.set(dedupeKey, work);
    try {
      const result = await work;
      respond(result.ok, result.payload, result.error, result.meta);
    } finally {
      inflightMap.delete(dedupeKey);
    }
  },
  poll: async ({ params, respond, context }) => {
    const p = params;
    if (!validatePollParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid poll params: ${formatValidationErrors(validatePollParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      to: string;
      question: string;
      options: string[];
      maxSelections?: number;
      durationSeconds?: number;
      durationHours?: number;
      silent?: boolean;
      isAnonymous?: boolean;
      threadId?: string;
      channel?: string;
      accountId?: string;
      idempotencyKey: string;
    };
    const idem = request.idempotencyKey;
    const cached = context.dedupe.get(`poll:${idem}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }
    const to = request.to.trim();
    const resolvedChannel = await resolveRequestedChannel({
      requestChannel: request.channel,
      unsupportedMessage: (input) => `unsupported poll channel: ${input}`,
    });
    if ("error" in resolvedChannel) {
      respond(false, undefined, resolvedChannel.error);
      return;
    }
    const { cfg, channel } = resolvedChannel;
    if (typeof request.durationSeconds === "number" && channel !== "telegram") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "durationSeconds is only supported for Telegram polls",
        ),
      );
      return;
    }
    if (typeof request.isAnonymous === "boolean" && channel !== "telegram") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "isAnonymous is only supported for Telegram polls"),
      );
      return;
    }
    const poll = {
      question: request.question,
      options: request.options,
      maxSelections: request.maxSelections,
      durationSeconds: request.durationSeconds,
      durationHours: request.durationHours,
    };
    const threadId =
      typeof request.threadId === "string" && request.threadId.trim().length
        ? request.threadId.trim()
        : undefined;
    const accountId =
      typeof request.accountId === "string" && request.accountId.trim().length
        ? request.accountId.trim()
        : undefined;
    try {
      const plugin = resolveOutboundChannelPlugin({ channel, cfg });
      const outbound = plugin?.outbound;
      if (!outbound?.sendPoll) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unsupported poll channel: ${channel}`),
        );
        return;
      }
      const resolved = resolveOutboundTarget({
        channel: channel,
        to,
        cfg,
        accountId,
        mode: "explicit",
      });
      if (!resolved.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(resolved.error)));
        return;
      }
      const normalized = outbound.pollMaxOptions
        ? normalizePollInput(poll, { maxOptions: outbound.pollMaxOptions })
        : normalizePollInput(poll);
      const result = await outbound.sendPoll({
        cfg,
        to: resolved.to,
        poll: normalized,
        accountId,
        threadId,
        silent: request.silent,
        isAnonymous: request.isAnonymous,
      });
      const payload: Record<string, unknown> = {
        runId: idem,
        messageId: result.messageId,
        channel,
      };
      if (result.toJid) {
        payload.toJid = result.toJid;
      }
      if (result.channelId) {
        payload.channelId = result.channelId;
      }
      if (result.conversationId) {
        payload.conversationId = result.conversationId;
      }
      if (result.pollId) {
        payload.pollId = result.pollId;
      }
      context.dedupe.set(`poll:${idem}`, {
        ts: Date.now(),
        ok: true,
        payload,
      });
      respond(true, payload, undefined, { channel });
    } catch (err) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      context.dedupe.set(`poll:${idem}`, {
        ts: Date.now(),
        ok: false,
        error,
      });
      respond(false, undefined, error, {
        channel,
        error: formatForLog(err),
      });
    }
  },
};
