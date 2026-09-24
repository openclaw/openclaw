import type { AsyncLocalStorage } from "node:async_hooks";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { createSessionRowPlacementProjection } from "./session-row-placement-projection.js";
import type {
  SessionRowReadView,
  SessionRowPreparationOptions,
  withPreparedSessionRows,
} from "./session-row-prepared-read.js";
import * as records from "./session-row-projection-record.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";

/** Materialization reads current physical relations from the projection's existing indexes. */
export function createSessionRowRelationReads(owner: {
  config: () => records.Inputs["cfg"];
  rows: ReadonlyMap<string, records.Row>;
  byParent: ReadonlyMap<string, Set<string>>;
  dirty: ReadonlySet<string>;
  referenced: (reference: string) => records.Row | undefined;
  readEntry: (row: records.Row) => records.Row["storedEntry"];
  acquireEntry: (row: records.Row, entry: records.Row["storedEntry"]) => records.Row | undefined;
}) {
  return {
    readSourceEntry(this: void, row: records.Row, key: string, residentOnly = false) {
      const source = owner.referenced(
        records.parentReference(
          owner.config(),
          key,
          row.agentId,
          row.storeTarget.storePath,
          owner.referenced,
        ),
      );
      return (
        source &&
        (!residentOnly && owner.dirty.has(records.identity(source))
          ? owner.readEntry(source)
          : source.storedEntry)
      );
    },
    readChildLinks(this: void, row: records.Row, residentOnly = false) {
      const links = [...records.dependents(row, owner.byParent)].flatMap((child) => {
        let value = owner.rows.get(child);
        if (value && !residentOnly && owner.dirty.has(child)) {
          value = owner.acquireEntry(value, owner.readEntry(value));
        }
        return value?.entry && [...value.parents].some((ref) => owner.referenced(ref) === row)
          ? [{ key: value.key, entry: value.entry }]
          : [];
      });
      // Keyed child refreshes reorder the parent index; presentation must stay stable.
      links.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return links;
    },
  };
}

/** Follow the projection's physical lineage and aggregate owners without a roster scan. */
function readSessionRowAncestors<T extends records.Row>(
  record: records.Row,
  owner: {
    cfg: records.Inputs["cfg"];
    context: SessionRowReadView["state"]["rowContext"];
    referenced: (reference: string) => records.Row | undefined;
    prepare: (row: records.Row) => T | undefined;
  },
): T[] | undefined {
  const seen = new Set([records.identity(record)]);
  const pending = [record];
  const ancestors: T[] = [];
  for (const child of pending) {
    const parents = new Set(child.parents);
    for (const run of owner.context.subagentRunsByChildSessionKey.get(child.key) ?? []) {
      // Requester rollups and collector summaries can belong to different controllers.
      for (const key of [run.requesterSessionKey, run.swarmRequesterSessionKey]) {
        if (key) {
          const agentId = run.requesterAgentId ?? child.agentId;
          parents.add(
            records.parentReference(
              owner.cfg,
              key,
              agentId,
              agentId === child.agentId ? child.storeTarget.storePath : undefined,
              owner.referenced,
            ),
          );
        }
      }
    }
    for (const ref of parents) {
      const parent = owner.referenced(ref);
      // A missing intermediary can still have registry-owned ancestors and rollups.
      if (!parent) {
        return undefined;
      }
      if (seen.has(records.identity(parent))) {
        continue;
      }
      // Omission makes clients refresh rather than accepting a partial tree.
      if (ancestors.length === 64) {
        return undefined;
      }
      seen.add(records.identity(parent));
      const prepared = owner.prepare(parent);
      if (!prepared) {
        return undefined;
      }
      ancestors.push(prepared);
      pending.push(prepared);
    }
  }
  return ancestors;
}

/** Exact event frames prepare the same bounded lineage later projected for each recipient. */
export function createSessionRowAncestorReads(owner: {
  state: () => { cfg: records.Inputs["cfg"]; context: SessionRowReadView["state"]["rowContext"] };
  referenced: (reference: string) => records.Row | undefined;
  lookup: (query: records.Lookup) => records.Row | undefined;
  prepareExactRows: (queries: readonly records.Lookup[]) => Promise<void> | undefined;
  assertExactRowsPrepared: (queries: readonly records.Lookup[]) => void;
  retainArchiveRows: () => { update: (ids: readonly string[]) => void; release: () => void };
  describe: SessionRowReadView["describe"];
  inOwnerContext: ReturnType<typeof AsyncLocalStorage.snapshot>;
  placementFacts: ReturnType<typeof createSessionRowPlacementProjection>;
  membership: {
    prepare: () => Promise<void>;
    needsPreparation: (
      queries: (config: records.Inputs["cfg"]) => readonly records.Lookup[],
    ) => boolean;
  };
  isActive: () => boolean;
  projection: () => SessionRowReadView & { isCurrent(row: records.Row): boolean };
}) {
  return {
    ancestorRows: (record: records.MaterializedRow) =>
      readSessionRowAncestors(record, {
        ...owner.state(),
        referenced: owner.referenced,
        prepare: (row) =>
          records.hasEntry(row) &&
          owner.placementFacts.isPrepared(row.entry.sessionId) &&
          !owner.membership.needsPreparation(() => [
            { ...row, storePath: row.storeTarget.storePath },
          ])
            ? owner.describe({ ...row, storePath: row.storeTarget.storePath }, row)
            : undefined,
      }),
    async withPreparedExactRows<T>(
      queries: (config: records.Inputs["cfg"]) => readonly records.Lookup[],
      consume: (read: SessionRowReadView) => T,
      options?: SessionRowPreparationOptions,
    ): ReturnType<typeof withPreparedSessionRows<T>> {
      const selected = options?.includeAncestors
        ? (config: records.Inputs["cfg"]) => {
            const targets = queries(config);
            return owner.inOwnerContext(() => [
              ...targets,
              ...targets.flatMap((query) => {
                const row = owner.lookup(query);
                const ancestors =
                  row &&
                  readSessionRowAncestors(row, {
                    ...owner.state(),
                    referenced: owner.referenced,
                    prepare: (parent) => (records.hasEntry(parent) ? parent : undefined),
                  });
                return (
                  ancestors?.map((parent) => ({
                    key: parent.key,
                    agentId: parent.agentId,
                    storePath: parent.storeTarget.storePath,
                  })) ?? []
                );
              }),
            ]);
          }
        : queries;
      const archivedRows = owner.retainArchiveRows();
      const membershipPending = Symbol("session-membership-pending");
      try {
        while (owner.isActive()) {
          while (owner.isActive() && owner.membership.needsPreparation(selected)) {
            await owner.membership.prepare();
          }
          const prepared = await owner.placementFacts.withPreparedRows<
            T | typeof membershipPending
          >(
            owner.projection(),
            owner.isActive,
            owner.lookup,
            selected,
            (targets) => {
              archivedRows.update(
                targets.flatMap((query) => {
                  if (
                    isIncognitoSessionKey(
                      resolveStoredSessionKeyForAgentStore({
                        cfg: owner.state().cfg,
                        sessionKey: query.key,
                        agentId: query.agentId,
                      }),
                    )
                  ) {
                    return [];
                  }
                  const row = owner.lookup(query);
                  return row?.entry?.archivedAt !== undefined ? [records.identity(row)] : [];
                }),
              );
              if (owner.membership.needsPreparation(() => targets)) {
                return owner.membership.prepare();
              }
              return owner.prepareExactRows(targets);
            },
            (read, targets) => {
              if (owner.membership.needsPreparation(() => targets)) {
                return membershipPending;
              }
              owner.assertExactRowsPrepared(targets);
              return consume(read);
            },
          );
          if (prepared.kind === "pending") {
            return prepared;
          }
          if (prepared.value !== membershipPending) {
            return { kind: "complete", value: prepared.value };
          }
        }
        throw new Error("Session row projection is no longer active");
      } finally {
        archivedRows.release();
      }
    },
  };
}
