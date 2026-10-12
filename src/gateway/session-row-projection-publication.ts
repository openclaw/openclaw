import { readSessionActivitySummary } from "../config/sessions/activity-summary.js";
import { readPreparedSessionEntryChange } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import {
  pluginStatePublication,
  pluginStateReadDependenciesAffected,
} from "../plugin-state/plugin-state-publication.js";
import {
  onSessionIdentityMutation,
  onSessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import * as records from "./session-row-projection-record.js";
import type { createSessionRowProjectionRevisions } from "./session-row-projection-revisions.js";

/** Apply committed metadata before observers without reacquiring it from SQLite. */
export function createSessionRowPublication(owner: {
  store: (path: string) => records.SessionRowStore | undefined;
  runAsOwner: <T>(run: () => T) => T;
  registryFactsReady: () => boolean;
  acquireEntry: (row: records.Row, entry: records.Row["storedEntry"]) => records.Row | undefined;
  markRelated: (row: records.Row, includeChildren: boolean) => void;
  placement: {
    publish: (sessionId: string, change: SessionRowChange) => boolean;
    invalidate: (sessionId: string) => void;
  };
  invalidateFacts: (row: records.Row, domain: true | "category") => boolean;
  enqueue: (row: records.Row | undefined) => void;
  defer: (row: records.Row) => void;
  deferArchive: (row: records.Row) => void;
  remove: (id: string) => void;
}) {
  function acquirePublishedEntry(
    row: records.Row,
    entry: NonNullable<records.Row["storedEntry"]>,
    databaseFacts?: records.RetainedSessionRowDatabaseFacts,
  ) {
    owner.markRelated(row, records.changesSessionRowDependents(row.storedEntry, entry));
    owner.runAsOwner(() => {
      if (entry.archivedAt !== undefined && !owner.registryFactsReady()) {
        // Retain committed metadata while the independent lineage owner recovers.
        const previous = row.storedEntry ?? row.entry;
        const changedIdentity =
          previous &&
          (previous.sessionId !== entry.sessionId ||
            previous.lifecycleRevision !== entry.lifecycleRevision);
        owner.deferArchive({
          ...(changedIdentity ? records.renewGeneration(row) : row),
          publishedSource: row.publishedSource,
          storedEntry: entry,
          sharingEntry: entry,
        });
        return;
      }
      const next = owner.acquireEntry(row, entry);
      if (next && databaseFacts) {
        next.retainedDatabaseFacts = databaseFacts;
        next.preparedAcpMeta = databaseFacts.acpMeta;
        next.preparedRuntimeOwnership = databaseFacts.runtimeOwnership;
        next.runtimeOwnershipDependencies = databaseFacts.runtimeOwnershipDependencies;
        next.hasBoard = databaseFacts.hasBoard;
      }
      owner.enqueue(next);
    });
  }
  return function publish(
    row: records.Row,
    change: Extract<SessionRowChange, { sessionKey: string }>,
    prepared = readPreparedSessionEntryChange(change, row.key),
  ) {
    const source = prepared?.source;
    const previousSource = row.publishedSource;
    if (
      source &&
      previousSource?.incarnation === source.incarnation &&
      previousSource.revision !== undefined &&
      source.revision !== undefined &&
      previousSource.revision > source.revision
    ) {
      return;
    }
    const store = owner.store(row.storeTarget.storePath);
    if (
      prepared &&
      (!source ||
        store?.identity !== source.identity ||
        store.birthtime !== source.birthtime ||
        store.filename !== source.filename)
    ) {
      return;
    }
    if (
      row.entry &&
      !change.factsInvalidated &&
      owner.placement.publish(row.entry.sessionId, change)
    ) {
      // This receipt changes only placement; the agent's prepared facets remain current.
      owner.defer(row);
      return;
    }
    const facts = change.facts;
    if (change.scope === "acp") {
      const entry = row.storedEntry;
      if (
        facts?.kind === "acp" &&
        (entry?.sessionId !== facts.sessionId ||
          (entry?.lifecycleRevision ?? null) !== facts.lifecycleRevision ||
          entry?.sessionStartedAt !== facts.sessionStartedAt)
      ) {
        return;
      }
      row.databaseFactsRevision++;
      row.pendingDatabaseFacts = undefined;
      const acpMeta = facts?.kind === "acp" ? freezeJsonSnapshot(facts.acp) : undefined;
      if (row.retainedDatabaseFacts) {
        row.retainedDatabaseFacts = { ...row.retainedDatabaseFacts, acpMeta };
      }
      row.preparedAcpMeta = acpMeta;
      owner.defer(row);
      return;
    }
    const sharingUnchanged =
      !change.factsInvalidated &&
      (facts?.kind === "unchanged" ||
        (!change.storePath && !facts && change.scope !== "session-entry"));
    if (facts?.kind === "removed") {
      owner.remove(records.identity(row));
      return;
    }
    if (prepared && !prepared.entry && !prepared.sharing) {
      return;
    }
    const previousFacts = row.retainedDatabaseFacts ?? row.pendingDatabaseFacts;
    const committed = prepared?.projection;
    const entry = prepared?.entry;
    const sameSession =
      entry &&
      previousFacts?.entry.sessionId === entry.sessionId &&
      previousFacts.entry.lifecycleRevision === entry.lifecycleRevision;
    const projection =
      committed ??
      (change.scope === "session-entry" &&
      sameSession &&
      (!readSessionActivitySummary(entry) || previousFacts.activitySummaryWatermark)
        ? previousFacts
        : undefined);
    const sameRuntimeOwner =
      sameSession &&
      previousFacts.entry.agentHarnessId === entry.agentHarnessId &&
      previousFacts.entry.modelSelectionLocked === entry.modelSelectionLocked &&
      previousFacts.entry.pluginOwnerId === entry.pluginOwnerId &&
      previousFacts.entry.previousSessionId === entry.previousSessionId;
    // Entry-only writes preserve Board/transcript facts. Shared facets retain their
    // independent lifetime; a changed binding requires preparation by that owner.
    const databaseFacts: records.RetainedSessionRowDatabaseFacts | undefined =
      entry && projection && !change.factsInvalidated
        ? {
            sessionKey: row.key,
            entry,
            hasBoard: projection.hasBoard,
            activitySummaryWatermark: projection.activitySummaryWatermark,
            runtimeOwnership: sameRuntimeOwner ? previousFacts.runtimeOwnership : undefined,
            runtimeOwnershipDependencies: sameRuntimeOwner
              ? previousFacts.runtimeOwnershipDependencies
              : undefined,
            acpMeta:
              sameSession && previousFacts.entry.sessionStartedAt === entry.sessionStartedAt
                ? previousFacts.acpMeta
                : undefined,
            repositoryWorkspace: !entry.repositoryWorkspaceId
              ? null
              : sameSession &&
                  previousFacts.entry.repositoryWorkspaceId === entry.repositoryWorkspaceId
                ? previousFacts.repositoryWorkspace
                : undefined,
          }
        : undefined;
    if (
      !prepared &&
      !change.factsInvalidated &&
      facts?.kind === "category" &&
      row.sharingEntry?.sessionId === facts.sessionId
    ) {
      const { category: _previousCategory, ...sharingEntry } = row.sharingEntry;
      const next = freezeJsonSnapshot({
        ...sharingEntry,
        ...(facts.category !== null ? { category: facts.category } : {}),
      });
      const retained =
        previousFacts?.entry === row.sharingEntry ? { ...previousFacts, entry: next } : undefined;
      records.invalidateDatabaseFacts(row, retained);
      if (row.sharingEntry === row.storedEntry) {
        acquirePublishedEntry(row, next, retained);
      } else {
        owner.defer({ ...row, sharingEntry: next });
      }
      return;
    }
    records.invalidateDatabaseFacts(row, databaseFacts);
    if (
      !prepared &&
      !change.factsInvalidated &&
      facts?.kind === "owner" &&
      row.sharingEntry?.sessionId === facts.sessionId &&
      (row.sharingEntry.lifecycleRevision ?? null) === facts.lifecycleRevision
    ) {
      const { owner: _previousOwner, ...sharingEntry } = row.sharingEntry;
      const next = freezeJsonSnapshot({
        ...sharingEntry,
        ...(facts.owner ? { owner: structuredClone(facts.owner) } : {}),
      });
      if (row.sharingEntry === row.storedEntry) {
        acquirePublishedEntry(row, next);
      } else {
        owner.defer({ ...row, sharingEntry: next });
      }
      return;
    }
    if (!prepared && !sharingUnchanged) {
      row.publishedSource = undefined;
    }
    if (
      !prepared?.entry &&
      change.factsInvalidated &&
      owner.invalidateFacts(row, change.factsInvalidated)
    ) {
      // Category uncertainty cannot retire an otherwise current row identity.
      owner.defer(row);
      return;
    }
    if (row.entry && change.scope !== "session-entry") {
      owner.placement.invalidate(row.entry.sessionId);
    }
    if (prepared?.entry) {
      acquirePublishedEntry(
        {
          ...row,
          publishedSource: prepared.source,
          unresolvedDatabaseFacts: undefined,
        },
        prepared.entry,
        databaseFacts,
      );
      return;
    }
    if (prepared?.sharing) {
      const sharing = prepared.sharing;
      const next =
        row.entry?.sessionId !== sharing.sessionId ||
        row.entry.lifecycleRevision !== sharing.lifecycleRevision
          ? records.renewGeneration(row)
          : { ...row };
      next.publishedSource = prepared.source;
      next.sharingEntry = sharing;
      if (sharing.archivedAt !== undefined && !owner.registryFactsReady()) {
        owner.deferArchive(next);
      } else {
        owner.defer(next);
      }
      return;
    }
    if (
      !sharingUnchanged &&
      (!facts ||
        facts.kind === "entry" ||
        change.factsInvalidated ||
        (facts.kind === "owner" &&
          (row.sharingEntry?.sessionId !== facts.sessionId ||
            (row.sharingEntry.lifecycleRevision ?? null) !== facts.lifecycleRevision)) ||
        ((facts.kind === "member" || facts.kind === "category") &&
          row.sharingEntry?.sessionId !== facts.sessionId))
    ) {
      row.sharingEntry = undefined;
    }
    owner.defer(row);
  };
}

export function subscribeSessionRowPublications({
  rows,
  dirty,
  revisions,
  advanceRevision,
  ensureMaterialized,
  publishTranscript,
  invalidateMembership,
  mark,
  mutateGeneration,
}: {
  rows: ReadonlyMap<string, records.Row>;
  dirty: Set<string>;
  revisions: Pick<
    ReturnType<typeof createSessionRowProjectionRevisions>,
    "invalidate" | "publishFacts"
  >;
  advanceRevision: () => void;
  ensureMaterialized: () => Promise<void>;
  publishTranscript: Parameters<typeof sessionChanges.subscribeFacts>[0];
  invalidateMembership: Parameters<typeof sessionChanges.subscribeFacts>[0];
  mark: Parameters<typeof sessionChanges.subscribeProjection>[0];
  mutateGeneration: Parameters<typeof onSessionIdentityMutation>[0];
}): Array<() => void> {
  return [
    pluginStatePublication.subscribeFacts((change) => {
      const changed: records.Row[] = [];
      for (const row of rows.values()) {
        if (
          !row.runtimeOwnershipDependencies ||
          !pluginStateReadDependenciesAffected(row.runtimeOwnershipDependencies, change)
        ) {
          continue;
        }
        row.databaseFactsRevision++;
        row.pendingDatabaseFacts = undefined;
        if (row.retainedDatabaseFacts) {
          row.retainedDatabaseFacts = {
            ...row.retainedDatabaseFacts,
            runtimeOwnership: undefined,
            runtimeOwnershipDependencies: undefined,
          };
        }
        row.preparedRuntimeOwnership = undefined;
        row.runtimeOwnershipDependencies = undefined;
        dirty.add(records.identity(row));
        changed.push(row);
      }
      if (changed.length > 0) {
        advanceRevision();
        revisions.invalidate(true);
        for (const row of changed) {
          revisions.publishFacts(row);
        }
        // Facts install synchronously; preparation starts after the publication frame.
        queueMicrotask(() => void ensureMaterialized().catch(() => {}));
      }
    }),
    sessionChanges.subscribeFacts(publishTranscript),
    sessionChanges.subscribeFacts(invalidateMembership),
    sessionChanges.subscribeProjection(mark),
    // Participant writers publish facts before their display-only lifecycle notice.
    onSessionLifecycleEvent((change) =>
      mark(change.reason === "participants" ? { ...change, facts: { kind: "unchanged" } } : change),
    ),
    onSessionIdentityMutation(mutateGeneration),
  ];
}
