import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import type {
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
} from "./session-accessor.sqlite-contract.js";
import { sqliteSessionStateDeleteSnapshotsEqual } from "./session-accessor.sqlite-delete-snapshot.js";
import { prepareSessionEntryMutationDatabase } from "./session-accessor.sqlite-entry-worker.js";
import {
  readSessionEntryLifecycleInDatabase,
  type SessionEntryLifecycleReadRequest,
} from "./session-accessor.sqlite-lifecycle-read.js";
import {
  shouldRemoveSessionEntry,
  collectSessionStateIdsForEntry,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type { ProjectedLifecycleMutation } from "./session-accessor.sqlite-lifecycle-types.js";
import { readSessionEntryLifecycleInWorker } from "./session-accessor.sqlite-lifecycle-worker.js";
import { cloneSessionEntry, withSqliteSessionDatabase } from "./session-accessor.sqlite-scope.js";

/** Builders consume detached selected rows; the storage owner reacquires the later reference snapshot. */
export async function projectSessionEntryLifecycleMutation(
  databaseOptions: OpenClawAgentDatabaseOptions & { path: string },
  params: {
    allowCanonicalRepair?: boolean;
    archiveDirectory: string;
    removals: readonly SessionEntryLifecycleRemoval[];
    upserts: readonly SessionEntryLifecycleUpsert[];
  },
  workerEnabled: boolean,
): Promise<{
  projected: ProjectedLifecycleMutation;
  databaseIdentity?: string;
  useWorker: boolean;
}> {
  let useWorker = workerEnabled;
  const read = (request: SessionEntryLifecycleReadRequest) =>
    useWorker
      ? readSessionEntryLifecycleInWorker(databaseOptions, request)
      : withSqliteSessionDatabase(databaseOptions, (database) =>
          readSessionEntryLifecycleInDatabase(database, request),
        );
  const request: SessionEntryLifecycleReadRequest = {
    stage: "snapshot",
    params: {
      allowCanonicalRepair: params.allowCanonicalRepair,
      removals: params.removals.map((removal) => ({
        sessionKey: removal.sessionKey,
        exactStoredKey: removal.exactStoredKey,
        readRawEntryJson: removal.expectedRawEntryJson !== undefined,
        readTranscriptSnapshot: removal.expectedTranscriptSnapshot !== undefined,
        ...(removal.expectedRawEntryJson !== undefined && removal.expectedEntry?.sessionId
          ? { transcriptSessionId: removal.expectedEntry.sessionId }
          : {}),
      })),
      upsertKeys: params.upserts.map((upsert) => upsert.sessionKey.trim()),
    },
  };
  if (useWorker) {
    // The former native projection opened its writer before reading rows or invoking builders.
    // Settle registration at that same admission boundary, before exposing a prepared snapshot.
    await prepareSessionEntryMutationDatabase(databaseOptions, () => {});
  }
  let selected = await read(request);
  if (selected?.stage === "native-required") {
    if (typeof selected.databaseIdentity !== "string") {
      throw new Error("Session lifecycle fallback lost its durable database identity");
    }
    useWorker = false;
    selected = await read({ ...request, expectedDatabaseIdentity: selected.databaseIdentity });
  }
  if (!selected || selected.stage !== "snapshot") {
    throw new Error("Session lifecycle preparation lost its selected rows");
  }
  const { snapshot, databaseIdentity } = selected;
  const { store } = snapshot;
  const changedSessionKeys = new Set<string>();
  const projectedRemovals: ProjectedLifecycleMutation["removals"] = [];
  for (const removal of params.removals) {
    const sessionKey = removal.exactStoredKey ? removal.sessionKey : removal.sessionKey.trim();
    let entry = removal.exactStoredKey || sessionKey ? store[sessionKey] : undefined;
    if (removal.expectedRawEntryJson !== undefined) {
      const currentRawEntryJson = snapshot.rawEntryJson.get(sessionKey);
      if (currentRawEntryJson !== removal.expectedRawEntryJson) {
        throw new Error(
          `SQLite session entry changed before raw lifecycle removal for ${sessionKey}`,
        );
      }
      entry = removal.expectedEntry ? cloneSessionEntry(removal.expectedEntry) : undefined;
    }
    if (!shouldRemoveSessionEntry(entry, removal)) {
      continue;
    }
    if (removal.expectedTranscriptSnapshot) {
      const sessionId = entry.sessionId;
      const observed = snapshot.transcriptSnapshots.get(sessionKey);
      if (
        !sessionId ||
        !observed ||
        !sqliteSessionStateDeleteSnapshotsEqual(observed, removal.expectedTranscriptSnapshot)
      ) {
        // Classification happens before the lifecycle writer lane. A stale fact
        // must become a no-op so newly live state is never archived and deleted.
        continue;
      }
    }
    projectedRemovals.push({
      // Capture each archive decision before an async builder can change its input.
      archiveTranscript: removal.archiveRemovedTranscript === true,
      expectedEntry: cloneSessionEntry(entry),
      removal,
      sessionKey,
    });
    changedSessionKeys.add(sessionKey);
    delete store[sessionKey];
  }

  const upsertedEntries: ProjectedLifecycleMutation["upsertedEntries"] = [];
  for (const upsert of params.upserts) {
    const sessionKey = upsert.sessionKey.trim();
    if (!sessionKey) {
      continue;
    }
    if (
      upsert.requiresRemovalSessionKey &&
      !projectedRemovals.some(
        (removal) => removal.sessionKey === upsert.requiresRemovalSessionKey?.trim(),
      )
    ) {
      continue;
    }
    const expectedEntry = store[sessionKey] ? cloneSessionEntry(store[sessionKey]) : undefined;
    if (upsert.resetBoundary && !expectedEntry) {
      throw new Error(
        `Cannot append reset boundary without an existing session row: ${sessionKey}`,
      );
    }
    const entry =
      upsert.buildEntry === undefined
        ? upsert.entry
        : await upsert.buildEntry({
            currentEntry: expectedEntry ? cloneSessionEntry(expectedEntry) : undefined,
            sessionKey,
          });
    if (!entry) {
      continue;
    }
    const cloned = cloneSessionEntry(entry);
    store[sessionKey] = cloned;
    changedSessionKeys.add(sessionKey);
    upsertedEntries.push({
      expectedEntry,
      sessionKey,
      entry: cloned,
      ...(upsert.routeContext !== undefined ? { routeContext: upsert.routeContext } : {}),
      ...(upsert.resetBoundary ? { resetBoundary: upsert.resetBoundary } : {}),
    });
  }
  if (projectedRemovals.length === 0) {
    return {
      projected: { deletePlans: [], removals: projectedRemovals, upsertedEntries },
      databaseIdentity,
      useWorker,
    };
  }
  const plans = await read({
    stage: "plans",
    expectedDatabaseIdentity: databaseIdentity,
    params: {
      archiveDirectory: params.archiveDirectory,
      excludedSessionKeys: [...changedSessionKeys],
      projectedSessionIds: Object.values(store).flatMap(collectSessionStateIdsForEntry),
      removals: projectedRemovals.map(
        ({ archiveTranscript, expectedEntry, removal, sessionKey }) => ({
          sessionKey,
          archiveTranscript,
          sessionIds: collectSessionStateIdsForEntry(expectedEntry),
          ...(expectedEntry.sessionId && removal.expectedTranscriptSnapshot
            ? {
                observedSnapshot: {
                  sessionId: expectedEntry.sessionId,
                  snapshot: removal.expectedTranscriptSnapshot,
                },
              }
            : {}),
        }),
      ),
    },
  });
  if (!plans || plans.stage !== "plans") {
    throw new Error("Session lifecycle preparation lost its reference snapshot");
  }
  return {
    projected: { deletePlans: plans.deletePlans, removals: projectedRemovals, upsertedEntries },
    databaseIdentity,
    useWorker,
  };
}
