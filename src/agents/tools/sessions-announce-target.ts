/**
 * Session announcement target resolver.
 *
 * Resolves where sessions_send/subagent completion announcements should be delivered.
 */
import { normalizeOptionalStringifiedId } from "@openclaw/normalization-core/string-coerce";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { parseThreadSessionSuffix } from "../../sessions/session-key-utils.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import type { GatewaySessionListRow } from "./sessions-helpers.js";
import type { AnnounceTarget } from "./sessions-send-helpers.js";
import { resolveAnnounceTargetFromKey } from "./sessions-send-helpers.js";

async function callGatewayLazy<T = unknown>(opts: CallGatewayOptions): Promise<T> {
  const { callGateway } = await import("../../gateway/call.js");
  return callGateway<T>(opts);
}

export async function resolveAnnounceTarget(params: {
  sessionKey: string;
  displayKey: string;
  targetAgentId?: string;
}): Promise<AnnounceTarget | null> {
  const parsed = resolveAnnounceTargetFromKey(params.sessionKey);
  const parsedDisplay = resolveAnnounceTargetFromKey(params.displayKey);
  const fallback = parsed ?? parsedDisplay ?? null;
  const fallbackThreadId =
    fallback?.threadId ??
    parseThreadSessionSuffix(params.sessionKey).threadId ??
    parseThreadSessionSuffix(params.displayKey).threadId;

  if (fallback) {
    const normalized = normalizeChannelId(fallback.channel);
    const plugin = normalized ? getChannelPlugin(normalized) : null;
    if (!plugin?.meta?.preferSessionLookupForAnnounceTarget) {
      return fallback;
    }
  }

  try {
    const list = await callGatewayLazy<{ sessions: Array<GatewaySessionListRow> }>({
      method: "sessions.list",
      params: {
        ...(params.targetAgentId ? { agentId: params.targetAgentId } : {}),
        includeGlobal: true,
        includeUnknown: true,
        limit: 200,
      },
    });
    const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
    // Unscoped keys can exist in more than one agent store. Never select a
    // delivery row by key alone when the adjacent target agent is the identity.
    const requireAgentMatch =
      !parseAgentSessionKey(params.sessionKey) || !parseAgentSessionKey(params.displayKey);
    const matchesAgent = (entry: GatewaySessionListRow) =>
      !requireAgentMatch || Boolean(params.targetAgentId && entry.agentId === params.targetAgentId);
    const match =
      sessions.find((entry) => entry?.key === params.sessionKey && matchesAgent(entry)) ??
      sessions.find((entry) => entry?.key === params.displayKey && matchesAgent(entry));

    const context = deliveryContextFromSession(match);
    const threadId = normalizeOptionalStringifiedId(context?.threadId ?? fallbackThreadId);
    if (context?.channel && context.to) {
      return { channel: context.channel, to: context.to, accountId: context.accountId, threadId };
    }
  } catch {
    // ignore
  }

  return fallback;
}
