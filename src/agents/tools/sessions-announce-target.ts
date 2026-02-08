import type { AnnounceTarget } from "./sessions-send-helpers.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { callGateway } from "../../gateway/call.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { SessionListRow } from "./sessions-helpers.js";
import { resolveAnnounceTargetFromKey } from "./sessions-send-helpers.js";

const log = createSubsystemLogger("agents/announce-target");

export async function resolveAnnounceTarget(params: {
  sessionKey: string;
  displayKey: string;
  requesterSessionKey?: string;
}): Promise<AnnounceTarget | null> {
  const parsed = resolveAnnounceTargetFromKey(params.sessionKey);
  const parsedDisplay = resolveAnnounceTargetFromKey(params.displayKey);
  const requesterParsed = params.requesterSessionKey
    ? resolveAnnounceTargetFromKey(params.requesterSessionKey)
    : null;

  // Priority 1: Requester's session (Current Context)
  // If the request comes from a valid channel (even internal), reply there immediately.
  // This prevents "channel sticking" when switching channels.
  if (requesterParsed) {
    return requesterParsed;
  }

  const fallback = parsed ?? parsedDisplay ?? null;

  if (fallback) {
    const normalized = normalizeChannelId(fallback.channel);
    const plugin = normalized ? getChannelPlugin(normalized) : null;
    if (!plugin?.meta?.preferSessionLookupForAnnounceTarget) {
      return fallback;
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
    if (channel && to && !isInternalMessageChannel(channel)) {
      return { channel, to, accountId };
    }
    if (channel && isInternalMessageChannel(channel)) {
      log.debug("skipping internal channel from sessions.list", {
        sessionKey: params.sessionKey,
        channel,
      });
    }
  } catch {
    // ignore
  }

  // Fallback: use requester's session key if not found above
  if (requesterParsed) {
    return requesterParsed;
  }

  // Don't return internal channels (webchat) as announce targets
  if (fallback && isInternalMessageChannel(fallback.channel)) {
    return null;
  }
  return fallback;
}
