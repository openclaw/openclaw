// Revalidates a restored follow-up's session authority against the live session entry.
//
// Queued turns keep the session authority admitted with them. A restored turn
// may have waited through a Gateway restart, so its persisted snapshot is only
// trusted while it still matches what the session owner holds now.
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PersistedFollowupRun } from "./persist-codec.types.js";

type SessionAuthorityRead =
  | { kind: "entry"; entry: SessionEntry | undefined }
  | { kind: "unreadable" };

function comparableToolOverrides(value: SessionEntry["toolOverrides"]): unknown {
  return value && Object.keys(value).length > 0 ? value : undefined;
}

/**
 * Reports whether a restored turn's session authority no longer matches the
 * live session entry.
 *
 * A changed permission mode, session root, or tool override set means the
 * session was tightened or otherwise changed while the turn waited, so the
 * persisted snapshot can no longer stand in for current authority. An entry
 * that cannot be read is treated as changed. A session with no entry is left to
 * execution admission, which already owns missing and reset sessions.
 */
export function createSessionAuthorityRevalidator(
  currentConfig: OpenClawConfig,
): (item: PersistedFollowupRun) => boolean {
  const reads = new Map<string, SessionAuthorityRead>();
  const readEntry = (agentId: string | undefined, sessionKey: string): SessionAuthorityRead => {
    const cacheKey = `${agentId ?? ""}\0${sessionKey}`;
    const cached = reads.get(cacheKey);
    if (cached) {
      return cached;
    }
    let read: SessionAuthorityRead;
    try {
      read = {
        kind: "entry",
        entry: loadSessionEntryReadOnly({
          agentId,
          sessionKey,
          storePath: resolveSessionStorePathCore(currentConfig.session?.store, { agentId }),
        }),
      };
    } catch {
      read = { kind: "unreadable" };
    }
    reads.set(cacheKey, read);
    return read;
  };

  return (item) => {
    const sessionKey = normalizeOptionalString(item.run.sessionKey);
    if (!sessionKey) {
      return false;
    }
    const read = readEntry(normalizeOptionalString(item.run.agentId), sessionKey);
    if (read.kind === "unreadable") {
      return true;
    }
    const current = read.entry;
    if (!current) {
      return false;
    }
    return (
      current.permissionMode !== item.run.permissionMode ||
      normalizeOptionalString(current.sessionRoot) !==
        normalizeOptionalString(item.run.sessionRoot) ||
      !isDeepStrictEqual(
        comparableToolOverrides(current.toolOverrides),
        comparableToolOverrides(item.run.toolOverrides),
      )
    );
  };
}
