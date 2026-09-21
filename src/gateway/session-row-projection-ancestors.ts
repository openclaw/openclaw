import type { AsyncLocalStorage } from "node:async_hooks";
import type { createSessionRowPlacementProjection } from "./session-row-placement-projection.js";
import type {
  SessionRowReadView,
  SessionRowPreparationOptions,
  withPreparedSessionRows,
} from "./session-row-prepared-read.js";
import * as records from "./session-row-projection-record.js";

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
  describe: SessionRowReadView["describe"];
  inOwnerContext: ReturnType<typeof AsyncLocalStorage.snapshot>;
  placementFacts: ReturnType<typeof createSessionRowPlacementProjection>;
  isActive: () => boolean;
  projection: () => SessionRowReadView & { isCurrent(row: records.Row): boolean };
}) {
  return {
    ancestorRows: (record: records.MaterializedRow) =>
      readSessionRowAncestors(record, {
        ...owner.state(),
        referenced: owner.referenced,
        prepare: (row) =>
          records.hasEntry(row) && owner.placementFacts.isPrepared(row.entry.sessionId)
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
      return owner.placementFacts.withPreparedRows(
        owner.projection(),
        owner.isActive,
        owner.lookup,
        selected,
        consume,
      );
    },
  };
}
