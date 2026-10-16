// Applies archive, pin, snooze, and unread facts to the projected session entry.
import type { ErrorShape, SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import { isPinnableSessionEntry } from "../config/sessions/session-pin-policy.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { invalidSessionRequest as invalid } from "./session-request-error.js";

export function applySessionPatchLifecycleFlags(params: {
  patch: SessionsPatchParams;
  next: SessionEntry;
  existingEntry?: SessionEntry;
  storeKey: string;
  now: number;
  archivedBy?: SessionEntry["archivedBy"];
}): ErrorShape | undefined {
  const { patch, next, existingEntry, storeKey, now, archivedBy } = params;
  if ("sidebarRoot" in patch) {
    if (patch.sidebarRoot === true) {
      if (isSubagentSessionKey(storeKey)) {
        return invalid("cannot promote a hidden subagent run; use a persistent session instead")
          .error;
      }
      next.sidebarRoot = true;
    } else {
      delete next.sidebarRoot;
    }
  }
  if ("archived" in patch) {
    if (patch.archived === true) {
      // Archived sessions leave the active quick-access set in the same write.
      if (next.archivedAt === undefined) {
        next.archivedAt = now;
        next.archiveReason = "manual";
        if (archivedBy) {
          next.archivedBy = archivedBy;
        } else {
          delete next.archivedBy;
        }
      }
      delete next.pinnedAt;
      delete next.snoozedUntil;
      delete next.snoozedAt;
    } else {
      delete next.archivedAt;
      delete next.archivedBy;
      delete next.archiveReason;
    }
  }

  const pinnable = isPinnableSessionEntry(storeKey, next);
  if (!pinnable) {
    delete next.pinnedAt;
    delete next.snoozedUntil;
    delete next.snoozedAt;
  }
  if ("snoozedUntil" in patch) {
    const snoozedUntil = patch.snoozedUntil;
    if (snoozedUntil === null) {
      delete next.snoozedUntil;
      delete next.snoozedAt;
    } else if (snoozedUntil !== undefined) {
      if (next.archivedAt !== undefined) {
        return invalid("cannot snooze an archived session; restore it first").error;
      }
      if (!pinnable) {
        return invalid("cannot snooze a child session; snooze its parent session instead").error;
      }
      if (!(snoozedUntil > now)) {
        return invalid("snooze wake time must be in the future").error;
      }
      if (next.snoozedUntil !== snoozedUntil) {
        next.snoozedUntil = snoozedUntil;
        next.snoozedAt = now;
      }
    }
  }
  if ("pinned" in patch) {
    if (patch.pinned === true) {
      if (next.archivedAt !== undefined) {
        return invalid("cannot pin an archived session; restore it first").error;
      }
      if (!pinnable) {
        return invalid("cannot pin a child session; pin its parent session instead").error;
      }
      next.pinnedAt ??= now;
      // Pinning promotes the session into the active quick-access set immediately.
      delete next.snoozedUntil;
      delete next.snoozedAt;
    } else {
      delete next.pinnedAt;
    }
  }

  if ("unread" in patch) {
    if (patch.unread === true) {
      // This timestamp is also the conditional-ack revision. Repeated writes in
      // one clock tick must still represent distinct manual unread intent.
      next.markedUnreadAt = Math.max(now, (existingEntry?.markedUnreadAt ?? 0) + 1);
    } else {
      next.lastReadAt = now;
      delete next.markedUnreadAt;
      delete next.agentStatus;
    }
  }

  return undefined;
}
