import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import { DEFAULT_CHAT_CHANNEL } from "../../channels/registry.js";
import { loadConfig } from "../../config/config.js";
import { createOutboundSendDeps } from "../../cli/deps.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { normalizeReplyPayloadsForDelivery } from "../../infra/outbound/payloads.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OutboundChannel } from "../../infra/outbound/targets.js";
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

export const sendHandlers: GatewayRequestHandlers = {
  send: async ({ params, respond, context }) => {
    const p = params as Record<string, unknown>;
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
      message: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      gifPlayback?: boolean;
      channel?: string;
      accountId?: string;
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
    const message = request.message.trim();
    const mediaUrls = Array.isArray(request.mediaUrls) ? request.mediaUrls : undefined;
    const channelInput = typeof request.channel === "string" ? request.channel : undefined;
    const normalizedChannel = channelInput ? normalizeChannelId(channelInput) : null;
    if (channelInput && !normalizedChannel) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unsupported channel: ${channelInput}`),
      );
      return;
    }
    const channel = normalizedChannel ?? DEFAULT_CHAT_CHANNEL;
    const accountId =
      typeof request.accountId === "string" && request.accountId.trim().length
        ? request.accountId.trim()
        : undefined;
    const outboundChannel = channel as Exclude<OutboundChannel, "none">;
    const plugin = getChannelPlugin(channel as ChannelId);
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
        const cfg = loadConfig();
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
          { text: message, mediaUrl: request.mediaUrl, mediaUrls },
        ]);
        const mirrorText = mirrorPayloads
          .map((payload) => payload.text)
          .filter(Boolean)
          .join("\n");
        const mirrorMediaUrls = mirrorPayloads.flatMap(
          (payload) => payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []),
        );
        const results = await deliverOutboundPayloads({
          cfg,
          channel: outboundChannel,
          to: resolved.to,
          accountId,
          payloads: [{ text: message, mediaUrl: request.mediaUrl, mediaUrls }],
          gifPlayback: request.gifPlayback,
          deps: outboundDeps,
          mirror:
            typeof request.sessionKey === "string" && request.sessionKey.trim()
              ? {
                  sessionKey: request.sessionKey.trim(),
                  agentId: resolveSessionAgentId({
                    sessionKey: request.sessionKey.trim(),
                    config: cfg,
                  }),
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
        if ("chatId" in result) payload.chatId = result.chatId;
        if ("channelId" in result) payload.channelId = result.channelId;
        if ("toJid" in result) payload.toJid = result.toJid;
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
    const p = params as Record<string, unknown>;
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
      durationHours?: number;
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
    const channelInput = typeof request.channel === "string" ? request.channel : undefined;
    const normalizedChannel = channelInput ? normalizeChannelId(channelInput) : null;
    if (channelInput && !normalizedChannel) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unsupported poll channel: ${channelInput}`),
      );
      return;
    }
    const channel = normalizedChannel ?? DEFAULT_CHAT_CHANNEL;
    const poll = {
      question: request.question,
      options: request.options,
      maxSelections: request.maxSelections,
      durationHours: request.durationHours,
    };
    const accountId =
      typeof request.accountId === "string" && request.accountId.trim().length
        ? request.accountId.trim()
        : undefined;
    try {
      const plugin = getChannelPlugin(channel as ChannelId);
      const outbound = plugin?.outbound;
      if (!outbound?.sendPoll) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unsupported poll channel: ${channel}`),
        );
        return;
      }
      const cfg = loadConfig();
      const resolved = resolveOutboundTarget({
        channel: channel as Exclude<OutboundChannel, "none">,
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
      });
      const payload: Record<string, unknown> = {
        runId: idem,
        messageId: result.messageId,
        channel,
      };
      if (result.toJid) payload.toJid = result.toJid;
      if (result.channelId) payload.channelId = result.channelId;
      if (result.conversationId) payload.conversationId = result.conversationId;
      if (result.pollId) payload.pollId = result.pollId;
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
