import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionSharingIdentity } from "../../packages/gateway-protocol/src/index.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { captureSessionActorStorageOwner } from "../config/sessions/session-actor-storage-binding.js";
import {
  first,
  identity,
  type Lookup,
  type Query,
  type Row,
} from "./session-row-projection-record.js";

type Contribution = { key: string; storePath: string; actor: SessionSharingIdentity };
const isSentinel = (key: string) => key === "global" || key === "unknown";

/** Retain only creator facts, not superseded rows or their materialized graphs. */
export function createSessionRowCreatorIndex() {
  const inOwner = AsyncLocalStorage.snapshot();
  const byCreator = new Map<string, Map<string, Contribution>>();
  const resolved = new Map<string, SessionSharingIdentity>();
  const dirty = new Set<string>();
  let paths: ReadonlyMap<string, number> | undefined;
  let disposed = false;
  function invalidate() {
    for (const id of byCreator.keys()) {
      dirty.add(id);
    }
  }
  return {
    update(previous: Row | undefined, next?: Row) {
      const before = previous?.entry?.createdActor;
      const after = next?.entry?.createdActor;
      if (
        Boolean(previous?.entry) === Boolean(next?.entry) &&
        before?.id === after?.id &&
        before?.type === after?.type &&
        before?.label === after?.label
      ) {
        return;
      }
      // Even a creatorless sentinel can hide a later store's creator.
      if (isSentinel((next ?? previous)!.key)) {
        invalidate();
      }
      if (previous && before?.id) {
        const contributors = byCreator.get(before.id);
        contributors?.delete(identity(previous));
        if (!contributors?.size) {
          byCreator.delete(before.id);
          resolved.delete(before.id);
        }
        dirty.add(before.id);
      }
      if (next && after?.id) {
        let contributors = byCreator.get(after.id);
        if (!contributors) {
          contributors = new Map();
          byCreator.set(after.id, contributors);
        }
        contributors.set(identity(next), {
          key: next.key,
          storePath: next.storeTarget.storePath,
          actor: { type: after.type, id: after.id, label: after.label },
        });
        dirty.add(after.id);
      }
    },
    list(
      selectPaths: () => ReadonlyMap<string, number>,
      matching: (query: { key: string }) => Row[],
    ) {
      const memory = captureSessionActorStorageOwner({});
      return inOwner(() => {
        const selectedPaths = selectPaths();
        if (disposed) {
          return [];
        }
        if (paths !== selectedPaths) {
          paths = selectedPaths;
          invalidate();
        }
        const sentinels = new Set<string>();
        for (const key of ["global", "unknown"]) {
          const winner = first(
            matching({ key }).filter(
              (row) => row.entry && selectedPaths.has(row.storeTarget.storePath),
            ),
            selectedPaths.keys(),
          );
          if (winner) {
            sentinels.add(identity(winner));
          }
        }
        // Match combined-store precedence, then SQLite's binary session-key order.
        const later = (candidate: Contribution, previous: Contribution | undefined) =>
          !previous ||
          selectedPaths.get(candidate.storePath)! > selectedPaths.get(previous.storePath)! ||
          (candidate.storePath === previous.storePath &&
            Buffer.compare(Buffer.from(candidate.key), Buffer.from(previous.key)) > 0);
        for (const id of dirty) {
          let last: Contribution | undefined;
          let labeled: Contribution | undefined;
          for (const [rowId, candidate] of byCreator.get(id) ?? []) {
            if (
              !selectedPaths.has(candidate.storePath) ||
              (isSentinel(candidate.key) && !sentinels.has(rowId))
            ) {
              continue;
            }
            if (later(candidate, last)) {
              last = candidate;
            }
            if (candidate.actor.label !== undefined && later(candidate, labeled)) {
              labeled = candidate;
            }
          }
          if (last) {
            resolved.set(id, {
              type: last.actor.type,
              id,
              ...(labeled ? { label: labeled.actor.label } : {}),
            });
          } else {
            resolved.delete(id);
          }
        }
        dirty.clear();
        return [
          ...Array.from(resolved.values(), ({ type, id, label }) => ({ type, id, label })),
          ...(memory
            ? (memory.owner
                ?.listSessions(memory.authority)
                .flatMap(({ entry }) =>
                  entry?.incognito && entry.createdActor?.id ? [entry.createdActor] : [],
                ) ?? [])
            : memorySessionActorOwners.list().flatMap((owner) =>
                owner
                  .listSessions({
                    assertCurrent: owner.assertCurrent,
                    authorize: owner.assertCurrent,
                  })
                  .flatMap(({ entry }) =>
                    entry?.incognito && entry.createdActor?.id ? [entry.createdActor] : [],
                  ),
              )),
        ];
      });
    },
    dispose() {
      disposed = true;
      byCreator.clear();
      resolved.clear();
      dirty.clear();
      paths = undefined;
    },
  };
}

/** Capability policy consumes only the receipt-updated metadata projection. */
export function createSessionRowCapabilityReader(owner: {
  state: () => { disposed: boolean; topologyDirty: boolean };
  lookup: (query: Lookup) => Row | undefined;
  matching: (query: Query, kind?: string) => Row[];
}) {
  return (
    query: { agentId: string; storePath: string } & (
      | { key: string; sessionId?: never }
      | { sessionId: string; key?: never }
    ),
  ) => {
    const state = owner.state();
    if (state.disposed || state.topologyDirty) {
      return undefined;
    }
    let row: Row | undefined;
    if (query.key !== undefined) {
      const candidate = owner.lookup(query);
      row = candidate?.key === query.key ? candidate : undefined;
    } else {
      const sessionId = query.sessionId;
      const scope = { agentId: query.agentId, storePath: query.storePath };
      const exact = owner.matching({ ...scope, key: sessionId }, "id");
      const candidates = (exact.length ? exact : owner.matching(scope))
        .filter((candidate) => !isInternalSessionEffectsKey(candidate.key))
        .toSorted((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
      if (candidates.some((candidate) => !candidate.sharingEntry)) {
        return undefined;
      }
      row =
        candidates.find((candidate) => candidate.sharingEntry?.sessionId === sessionId) ??
        candidates.find((candidate) => candidate.sharingEntry?.sessionId.trim() === sessionId);
    }
    // Known absence is authoritative. A row awaiting metadata preparation is not absent.
    return row && (!row.storedEntry || row.sharingEntry !== row.storedEntry)
      ? undefined
      : { entry: row?.storedEntry };
  };
}
