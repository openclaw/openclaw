import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { callGateway } from "../../gateway/call.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.js";
import { SessionListRow } from "./sessions-helpers.js";
import type { AnnounceTarget } from "./sessions-send-helpers.js";
import { resolveAnnounceTargetFromKey } from "./sessions-send-helpers.js";

export type AnnounceTargetDecision =
  | { kind: "external_target"; target: AnnounceTarget }
  | { kind: "no_external_target" }
  | { kind: "unknown"; reason: "miss" | "partial" | "missing_delivery" | "error" };

function prefersSessionLookupForChannel(channel?: string) {
  const normalized = normalizeChannelId(channel);
  return Boolean(
    normalized && getChannelPlugin(normalized)?.meta?.preferSessionLookupForAnnounceTarget,
  );
}

function prefersSessionLookupForAnnounceTarget(sessionKey: string, match?: SessionListRow) {
  const parsed = resolveAnnounceTargetFromKey(sessionKey);
  if (parsed && prefersSessionLookupForChannel(parsed.channel)) {
    return true;
  }
  if (!match || typeof match !== "object") {
    return false;
  }

  const deliveryContext =
    match.deliveryContext && typeof match.deliveryContext === "object"
      ? (match.deliveryContext as Record<string, unknown>)
      : undefined;
  const origin =
    match.origin && typeof match.origin === "object"
      ? (match.origin as Record<string, unknown>)
      : undefined;
  const channelCandidates = [
    typeof deliveryContext?.channel === "string" ? deliveryContext.channel : undefined,
    typeof match.lastChannel === "string" ? match.lastChannel : undefined,
    typeof match.channel === "string" ? match.channel : undefined,
    typeof origin?.provider === "string" ? origin.provider : undefined,
  ];

  return channelCandidates.some((channel) => prefersSessionLookupForChannel(channel));
}

function readSessionOriginField(
  origin: Record<string, unknown> | undefined,
  key: "provider" | "accountId",
) {
  return typeof origin?.[key] === "string" ? origin[key] : undefined;
}

function readSessionThreadId(value: unknown): string | number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  return undefined;
}

function resolveNormalizedDelivery(match?: SessionListRow) {
  if (!match || typeof match !== "object") {
    return undefined;
  }
  const origin =
    match.origin && typeof match.origin === "object"
      ? (match.origin as Record<string, unknown>)
      : undefined;
  const originProvider = readSessionOriginField(origin, "provider");
  const originAccountId = readSessionOriginField(origin, "accountId");
  const normalizedDelivery = deliveryContextFromSession({
    // Bare row.channel is only a lookup hint, not a routable delivery field.
    channel: originProvider,
    lastChannel: typeof match.lastChannel === "string" ? match.lastChannel : undefined,
    lastTo: typeof match.lastTo === "string" ? match.lastTo : undefined,
    lastAccountId: typeof match.lastAccountId === "string" ? match.lastAccountId : undefined,
    lastThreadId: readSessionThreadId((match as Record<string, unknown>).lastThreadId),
    origin: {
      provider: originProvider,
      threadId: readSessionThreadId(origin?.threadId),
    },
    deliveryContext: match.deliveryContext,
  });

  if (normalizedDelivery && !normalizedDelivery.accountId && originAccountId) {
    const normalizedOriginProvider =
      typeof originProvider === "string"
        ? (normalizeChannelId(originProvider) ?? originProvider.trim())
        : undefined;
    if (!normalizedOriginProvider || normalizedDelivery?.channel === normalizedOriginProvider) {
      return {
        ...normalizedDelivery,
        accountId: originAccountId,
      };
    }
  }

  return normalizedDelivery;
}

export function resolveParsedAnnounceTargetDecision(
  sessionKey: string,
): AnnounceTargetDecision | null {
  const parsed = resolveAnnounceTargetFromKey(sessionKey);

  if (parsed) {
    if (!prefersSessionLookupForAnnounceTarget(sessionKey)) {
      return { kind: "external_target", target: parsed };
    }
  }

  return null;
}

export async function resolveAnnounceTarget(params: {
  sessionKey: string;
  displayKey: string;
}): Promise<AnnounceTargetDecision> {
  const parsedDecision = resolveParsedAnnounceTargetDecision(params.sessionKey);
  if (parsedDecision) {
    return parsedDecision;
  }

  try {
    const list = await callGateway<{ sessions: Array<SessionListRow> }>({
      method: "sessions.list",
      params: {
        includeGlobal: true,
        includeUnknown: true,
        limit: 200,
      },
    });
    const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
    const match =
      sessions.find((entry) => entry?.key === params.sessionKey) ??
      sessions.find((entry) => entry?.key === params.displayKey);
    const normalizedDelivery = resolveNormalizedDelivery(match);
    if (normalizedDelivery?.channel && normalizedDelivery.to) {
      return {
        kind: "external_target",
        target: {
          channel: normalizedDelivery.channel,
          to: normalizedDelivery.to,
          accountId: normalizedDelivery.accountId,
          threadId:
            normalizedDelivery.threadId != null ? String(normalizedDelivery.threadId) : undefined,
        },
      };
    }
    if (match) {
      if (
        prefersSessionLookupForAnnounceTarget(params.sessionKey, match) ||
        prefersSessionLookupForAnnounceTarget(params.displayKey, match)
      ) {
        return normalizedDelivery
          ? { kind: "unknown", reason: "partial" }
          : { kind: "unknown", reason: "missing_delivery" };
      }
      if (normalizedDelivery) {
        return { kind: "unknown", reason: "partial" };
      }
      return { kind: "no_external_target" };
    }
  } catch {
    return { kind: "unknown", reason: "error" };
  }

  return { kind: "unknown", reason: "miss" };
}
