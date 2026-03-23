import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { callGateway } from "../../gateway/call.js";
import { SessionListRow } from "./sessions-helpers.js";
import type { AnnounceTarget } from "./sessions-send-helpers.js";
import { resolveAnnounceTargetFromKey } from "./sessions-send-helpers.js";

export type AnnounceTargetDecision =
  | { kind: "external_target"; target: AnnounceTarget }
  | { kind: "no_external_target" }
  | { kind: "unknown"; reason: "miss" | "partial" | "missing_delivery" | "error" };

function prefersSessionLookupForAnnounceTarget(sessionKey: string) {
  const parsed = resolveAnnounceTargetFromKey(sessionKey);
  if (!parsed) {
    return false;
  }
  const normalized = normalizeChannelId(parsed.channel);
  return Boolean(
    normalized && getChannelPlugin(normalized)?.meta?.preferSessionLookupForAnnounceTarget,
  );
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

    const deliveryContext =
      match?.deliveryContext && typeof match.deliveryContext === "object"
        ? (match.deliveryContext as Record<string, unknown>)
        : undefined;
    const channel =
      (typeof deliveryContext?.channel === "string" ? deliveryContext.channel : undefined) ??
      (typeof match?.lastChannel === "string" ? match.lastChannel : undefined);
    const to =
      (typeof deliveryContext?.to === "string" ? deliveryContext.to : undefined) ??
      (typeof match?.lastTo === "string" ? match.lastTo : undefined);
    const accountId =
      (typeof deliveryContext?.accountId === "string" ? deliveryContext.accountId : undefined) ??
      (typeof match?.lastAccountId === "string" ? match.lastAccountId : undefined);
    if (channel && to) {
      return { kind: "external_target", target: { channel, to, accountId } };
    }
    if (channel || to || accountId) {
      return { kind: "unknown", reason: "partial" };
    }
    if (match) {
      if (
        prefersSessionLookupForAnnounceTarget(params.sessionKey) ||
        prefersSessionLookupForAnnounceTarget(params.displayKey)
      ) {
        return { kind: "unknown", reason: "missing_delivery" };
      }
      return { kind: "no_external_target" };
    }
  } catch {
    return { kind: "unknown", reason: "error" };
  }

  return { kind: "unknown", reason: "miss" };
}
