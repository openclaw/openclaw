/**
 * Session announcement target resolver.
 *
 * Resolves where sessions_send/subagent completion announcements should be delivered.
 */
import { normalizeOptionalStringifiedId } from "@openclaw/normalization-core/string-coerce";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { parseThreadSessionSuffix } from "../../sessions/session-key-utils.js";
import {
  deliveryContextFromSession,
  deliveryContextKey,
} from "../../utils/delivery-context.shared.js";
import type { SessionListRow } from "./sessions-helpers.js";
import type { AnnounceTarget } from "./sessions-send-helpers.js";
import { resolveAnnounceTargetFromKey } from "./sessions-send-helpers.js";

async function resolveCanonicalSessionKey(key: string): Promise<string | undefined> {
  try {
    const resolved = await callGatewayLazy<{ ok?: boolean; key?: string }>({
      method: "sessions.resolve",
      params: { key, allowMissing: true },
    });
    if (resolved?.ok === false) {
      return undefined;
    }
    return typeof resolved?.key === "string" && resolved.key.trim()
      ? resolved.key.trim()
      : undefined;
  } catch (error) {
    const olderGatewayRejectedProbe =
      error instanceof GatewayClientRequestError &&
      error.gatewayCode === "INVALID_REQUEST" &&
      error.message.includes("invalid sessions.resolve params") &&
      error.message.includes("unexpected property 'allowMissing'");
    if (!olderGatewayRejectedProbe) {
      return undefined;
    }
    try {
      const resolved = await callGatewayLazy<{ ok?: boolean; key?: string }>({
        method: "sessions.resolve",
        params: { key },
      });
      if (resolved?.ok === false) {
        return undefined;
      }
      return typeof resolved?.key === "string" && resolved.key.trim()
        ? resolved.key.trim()
        : undefined;
    } catch {
      return undefined;
    }
  }
}

function findSessionMatch(params: {
  sessions: Array<SessionListRow>;
  sessionKey: string;
  displayKey: string;
  sessionCanonicalKey?: string;
  displayCanonicalKey?: string;
  fallback?: AnnounceTarget | null;
}): SessionListRow | undefined {
  const byKey = params.sessions.find(
    (entry) => entry?.key === params.sessionKey || entry?.key === params.displayKey,
  );
  if (byKey) {
    return byKey;
  }

  const byCanonicalKey = params.sessions.find(
    (entry) =>
      entry?.key === params.sessionCanonicalKey || entry?.key === params.displayCanonicalKey,
  );
  if (byCanonicalKey) {
    return byCanonicalKey;
  }

  const fallbackKey = deliveryContextKey({
    channel: params.fallback?.channel,
    to: params.fallback?.to,
    accountId: params.fallback?.accountId,
    threadId: params.fallback?.threadId,
  });
  if (!fallbackKey) {
    return undefined;
  }

  return params.sessions.find(
    (entry) => deliveryContextKey(deliveryContextFromSession(entry)) === fallbackKey,
  );
}

async function callGatewayLazy<T = unknown>(opts: CallGatewayOptions): Promise<T> {
  const { callGateway } = await import("../../gateway/call.js");
  return callGateway<T>(opts);
}

export async function resolveAnnounceTarget(params: {
  sessionKey: string;
  displayKey: string;
}): Promise<AnnounceTarget | null> {
  const parsed = resolveAnnounceTargetFromKey(params.sessionKey);
  const parsedDisplay = resolveAnnounceTargetFromKey(params.displayKey);
  const fallback = parsed ?? parsedDisplay ?? null;
  const fallbackThreadId =
    fallback?.threadId ??
    parseThreadSessionSuffix(params.sessionKey).threadId ??
    parseThreadSessionSuffix(params.displayKey).threadId;
  const fallbackNormalizedChannel = fallback ? normalizeChannelId(fallback.channel) : null;
  const fallbackPlugin = fallbackNormalizedChannel
    ? getChannelPlugin(fallbackNormalizedChannel)
    : null;
  const prefersSessionLookup = fallbackPlugin?.meta?.preferSessionLookupForAnnounceTarget === true;

  if (fallback) {
    // Only return early for known plugin channels that don't prefer session lookup.
    // For non-plugin channels (e.g. bncr), fall through to session-based lookup
    // so the delivery context's target format (e.g. "Bncr:tgBot:...") is used
    // instead of the raw conversation id.
    if (fallbackPlugin && !prefersSessionLookup) {
      return fallback;
    }
  }

  try {
    const list = await callGatewayLazy<{ sessions: Array<SessionListRow> }>({
      method: "sessions.list",
      params: {
        includeGlobal: true,
        includeUnknown: true,
        limit: 200,
      },
    });
    const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
    let match = findSessionMatch({
      sessions,
      sessionKey: params.sessionKey,
      displayKey: params.displayKey,
      fallback,
    });
    if (!match && prefersSessionLookup) {
      const [sessionCanonicalKey, displayCanonicalKey] = await Promise.all([
        resolveCanonicalSessionKey(params.sessionKey),
        params.displayKey === params.sessionKey
          ? Promise.resolve(undefined)
          : resolveCanonicalSessionKey(params.displayKey),
      ]);
      match = findSessionMatch({
        sessions,
        sessionKey: params.sessionKey,
        displayKey: params.displayKey,
        sessionCanonicalKey,
        displayCanonicalKey,
        fallback,
      });
    }

    const context = deliveryContextFromSession(match);
    const threadId = normalizeOptionalStringifiedId(context?.threadId ?? fallbackThreadId);
    if (context?.channel && context.to) {
      return {
        channel: context.channel,
        to: context.to,
        accountId: context.accountId,
        threadId,
      };
    }
  } catch {
    // ignore
  }

  return fallback;
}
