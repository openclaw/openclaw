import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { callGateway } from "../../gateway/call.js";
import { SessionListRow } from "./sessions-helpers.js";
import type { AnnounceTarget } from "./sessions-send-helpers.js";
import { resolveAnnounceTargetFromKey } from "./sessions-send-helpers.js";

export type AnnounceTargetDecision =
  | { kind: "external_target"; target: AnnounceTarget }
  | { kind: "no_external_target" }
  | { kind: "unknown"; reason: "miss" | "partial" | "error" };

export async function resolveAnnounceTarget(params: {
  sessionKey: string;
  displayKey: string;
}): Promise<AnnounceTargetDecision> {
  const parsed = resolveAnnounceTargetFromKey(params.sessionKey);

  if (parsed) {
    const normalized = normalizeChannelId(parsed.channel);
    const plugin = normalized ? getChannelPlugin(normalized) : null;
    if (!plugin?.meta?.preferSessionLookupForAnnounceTarget) {
      return { kind: "external_target", target: parsed };
    }
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
      return { kind: "no_external_target" };
    }
  } catch {
    return { kind: "unknown", reason: "error" };
  }

  return { kind: "unknown", reason: "miss" };
}
