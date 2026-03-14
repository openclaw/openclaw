import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { callGateway } from "../../gateway/call.js";
import { SessionListRow } from "./sessions-helpers.js";
import type { AnnounceTarget } from "./sessions-send-helpers.js";
import { resolveAnnounceTargetFromKey } from "./sessions-send-helpers.js";

function extractDeliveryTarget(entry: SessionListRow | undefined | null): AnnounceTarget | null {
  const deliveryContext =
    entry?.deliveryContext && typeof entry.deliveryContext === "object"
      ? (entry.deliveryContext as Record<string, unknown>)
      : undefined;
  const channel =
    (typeof deliveryContext?.channel === "string" ? deliveryContext.channel : undefined) ??
    (typeof entry?.lastChannel === "string" ? entry.lastChannel : undefined);
  const to =
    (typeof deliveryContext?.to === "string" ? deliveryContext.to : undefined) ??
    (typeof entry?.lastTo === "string" ? entry.lastTo : undefined);
  const accountId =
    (typeof deliveryContext?.accountId === "string" ? deliveryContext.accountId : undefined) ??
    (typeof entry?.lastAccountId === "string" ? entry.lastAccountId : undefined);

  if (!channel || !to) {
    return null;
  }
  return { channel, to, accountId };
}

export async function resolveAnnounceTarget(params: {
  sessionKey: string;
  displayKey: string;
}): Promise<AnnounceTarget | null> {
  const parsed = resolveAnnounceTargetFromKey(params.sessionKey);
  const parsedDisplay = resolveAnnounceTargetFromKey(params.displayKey);
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

    const directTarget = extractDeliveryTarget(match);
    if (directTarget) {
      return directTarget;
    }

    const spawnedBy = typeof match?.spawnedBy === "string" ? match.spawnedBy.trim() : "";
    if (spawnedBy) {
      const parentMatch = sessions.find((entry) => entry?.key === spawnedBy);
      const parentTarget = extractDeliveryTarget(parentMatch);
      if (parentTarget) {
        return parentTarget;
      }
    }
  } catch {
    // ignore
  }

  return fallback;
}
