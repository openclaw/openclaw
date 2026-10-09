import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { resolveSessionWorkStartError } from "../../config/sessions/lifecycle.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  mergeSessionSnapshotChanges,
  sessionSnapshotTouchedFieldsConflict,
} from "../../config/sessions/session-snapshot-merge.js";

type PersistReplySessionEntryParams = {
  allowCreate?: boolean;
  entry: SessionEntry;
  initialEntry: SessionEntry;
  reassertLiveModelSwitchPending?: boolean;
  requireModelSelectionUnlocked?: boolean;
  sessionKey: string;
  skipMaintenance?: boolean;
  storePath: string;
  touchedFields?: ReadonlyArray<keyof SessionEntry>;
  validateCommit?: () => string | undefined;
};

type PersistReplySessionEntryResult =
  | { status: "current"; entry: SessionEntry }
  | { status: "model-selection-locked"; entry: SessionEntry }
  | { status: "commit-rejected"; error: string; entry: SessionEntry }
  | { status: "lifecycle-invalidated"; error: string; entry?: SessionEntry };

class SessionCommitRejectedError extends Error {}

/** Persists reply-owned state without reverting concurrent session management. */
export async function persistReplySessionEntry(
  params: PersistReplySessionEntryParams,
): Promise<PersistReplySessionEntryResult> {
  let lifecycleError: string | undefined;
  let lifecycleEntry: SessionEntry | undefined;
  let lockedEntry: SessionEntry | undefined;
  let commitEntry = params.initialEntry;
  let persisted: SessionEntry | null;
  try {
    persisted = await patchSessionEntryCore(
      { sessionKey: params.sessionKey, storePath: params.storePath },
      (_entry, { existingEntry }) => {
        commitEntry = existingEntry ?? params.initialEntry;
        if (!existingEntry && params.allowCreate === true) {
          return params.entry;
        }
        lifecycleError = resolveSessionWorkStartError(params.sessionKey, existingEntry, {
          expectedSessionId: params.initialEntry.sessionId,
        });
        if (!existingEntry) {
          return null;
        }
        if (lifecycleError) {
          lifecycleEntry = existingEntry;
          return null;
        }
        if (
          params.requireModelSelectionUnlocked === true &&
          existingEntry.modelSelectionLocked === true
        ) {
          lockedEntry = existingEntry;
          return null;
        }
        const changes = {
          initial: params.initialEntry,
          next: params.entry,
          current: existingEntry,
          touchedFields: params.touchedFields,
          reassertLiveModelSwitchPending: params.reassertLiveModelSwitchPending,
        };
        if (sessionSnapshotTouchedFieldsConflict(changes)) {
          return null;
        }
        // Reply flows persist broad snapshots. Project only reply-owned changes
        // so concurrent lifecycle, policy, and privacy updates remain authoritative.
        return mergeSessionSnapshotChanges(changes);
      },
      {
        fallbackEntry: params.entry,
        replaceEntry: true,
        skipMaintenance: params.skipMaintenance,
        assertCommitAllowed: params.validateCommit
          ? () => {
              const error = params.validateCommit?.();
              if (error) {
                throw new SessionCommitRejectedError(error);
              }
            }
          : undefined,
      },
    );
  } catch (error) {
    if (error instanceof SessionCommitRejectedError) {
      return { status: "commit-rejected", error: error.message, entry: commitEntry };
    }
    throw error;
  }
  if (lifecycleError) {
    return {
      status: "lifecycle-invalidated",
      error: lifecycleError,
      ...(lifecycleEntry ? { entry: lifecycleEntry } : {}),
    };
  }
  if (lockedEntry) {
    return { status: "model-selection-locked", entry: lockedEntry };
  }
  if (!persisted) {
    return {
      status: "lifecycle-invalidated",
      error: `Session "${params.sessionKey}" changed while starting work. Retry.`,
    };
  }
  return { status: "current", entry: persisted };
}
