import { normalizeOptionalStringifiedId } from "@openclaw/normalization-core/string-coerce";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import {
  parseSessionDeliveryRoute,
  parseThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import type { GatewaySessionListRow } from "./sessions-helpers.js";
import type { SessionDeliveryTarget } from "./sessions-send-helpers.js";
import { resolveSessionDeliveryTargetFromKey } from "./sessions-send-helpers.js";

export async function resolveSessionsSendReplyTarget(params: {
  sessionKey: string;
  displayKey: string;
  callGateway: AgentToolGatewayRequestCaller;
  agentId?: string;
}): Promise<SessionDeliveryTarget | null> {
  const parsed = resolveSessionDeliveryTargetFromKey(params.sessionKey);
  const parsedDisplay = resolveSessionDeliveryTargetFromKey(params.displayKey);
  const fallback = parsed ?? parsedDisplay ?? null;
  const fallbackThreadId =
    fallback?.threadId ??
    parseThreadSessionSuffix(params.sessionKey).threadId ??
    parseThreadSessionSuffix(params.displayKey).threadId;

  if (fallback) {
    const normalized = normalizeChannelId(fallback.channel);
    const plugin = normalized ? getChannelPlugin(normalized) : null;
    const route =
      parseSessionDeliveryRoute(params.sessionKey) ?? parseSessionDeliveryRoute(params.displayKey);
    // Stored DM delivery context carries the authoritative account and thread;
    // use the parsed address only when that exact session has no saved route.
    const isDirectRoute = route?.peerKind === "direct" || route?.peerKind === "dm";
    if (!isDirectRoute && !plugin?.meta?.preferSessionLookupForAnnounceTarget) {
      return fallback;
    }
  }

  try {
    const read = (key: string) =>
      params.callGateway<{ session: GatewaySessionListRow | null }>({
        method: "sessions.describe",
        params: { key, agentId: params.agentId },
      });
    const described = await read(params.sessionKey);
    const match =
      described.session ??
      (params.displayKey !== params.sessionKey ? (await read(params.displayKey)).session : null);

    const context = match?.deliveryContext;
    const threadId = normalizeOptionalStringifiedId(context?.threadId ?? fallbackThreadId);
    if (context?.channel && context.to) {
      return { channel: context.channel, to: context.to, accountId: context.accountId, threadId };
    }
  } catch {
    // ignore
  }

  return fallback;
}
