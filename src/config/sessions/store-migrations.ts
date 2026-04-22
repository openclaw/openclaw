import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { buildGroupDisplayName, isLegacyGroupDisplayName } from "./group.js";
import type { SessionEntry } from "./types.js";

function parseStoredGroupKey(key: string): { channel?: string; id?: string } {
  const parts = key.split(":").filter(Boolean);
  if (parts.length >= 3) {
    const offset = parts[0] === "agent" && parts.length >= 5 ? 2 : 0;
    const channel = parts[offset];
    const kind = parts[offset + 1];
    if (kind === "group" || kind === "channel") {
      return {
        channel,
        id: parts.slice(offset + 2).join(":"),
      };
    }
  }
  return {};
}

export function applySessionStoreMigrations(store: Record<string, SessionEntry>): void {
  // Best-effort migration: message provider → channel naming.
  for (const [sessionKey, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const rec = entry as unknown as Record<string, unknown>;
    if (typeof rec.channel !== "string" && typeof rec.provider === "string") {
      rec.channel = rec.provider;
      delete rec.provider;
    }
    if (typeof rec.lastChannel !== "string" && typeof rec.lastProvider === "string") {
      rec.lastChannel = rec.lastProvider;
      delete rec.lastProvider;
    }

    // Best-effort migration: legacy `room` field → `groupChannel` (keep value, prune old key).
    if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
      rec.groupChannel = rec.room;
      delete rec.room;
    } else if ("room" in rec) {
      delete rec.room;
    }

    const parsed = parseStoredGroupKey(sessionKey);
    const channel = normalizeOptionalString(rec.channel) ?? parsed.channel;
    const id = normalizeOptionalString(rec.groupId) ?? parsed.id;
    const subject = normalizeOptionalString(rec.subject);
    const groupChannel = normalizeOptionalString(rec.groupChannel);
    const space = normalizeOptionalString(rec.space);
    if (!channel || !(subject || groupChannel || space)) {
      continue;
    }

    const nextDisplayName = buildGroupDisplayName({
      provider: channel,
      subject,
      groupChannel,
      space,
      id,
      key: sessionKey,
    });
    const currentDisplayName = normalizeOptionalString(rec.displayName);
    if (
      !currentDisplayName ||
      isLegacyGroupDisplayName(currentDisplayName, {
        provider: channel,
        subject,
        groupChannel,
        space,
        id,
        key: sessionKey,
      })
    ) {
      rec.displayName = nextDisplayName;
    }
  }
}
