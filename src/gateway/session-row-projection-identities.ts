import type { SessionSharingIdentity } from "../../packages/gateway-protocol/src/index.js";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.sqlite-entry.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
import { listOpenIncognitoAgentDatabases } from "../state/openclaw-agent-db.js";
import { first, identity, type Row } from "./session-row-projection-record.js";

type Contribution = { key: string; storePath: string; actor: SessionSharingIdentity };
const isSentinel = (key: string) => key === "global" || key === "unknown";

/** Retain only creator facts, not superseded rows or their materialized graphs. */
export function createSessionRowCreatorIndex() {
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
    list(selectedPaths: ReadonlyMap<string, number>, matching: (query: { key: string }) => Row[]) {
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
        ...listOpenIncognitoSessionCreators(),
      ];
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

/** Incognito creators preserve the existing picker scope without entering resident memory. */
function listOpenIncognitoSessionCreators() {
  return listOpenIncognitoAgentDatabases().flatMap((target) => {
    if (readAgentDatabaseAdmissionRefusal(target.agentId)) {
      return [];
    }
    return listSessionEntriesReadOnly({ ...target, projection: "list", clone: false }).flatMap(
      ({ sessionKey, entry }) =>
        isIncognitoSessionKey(sessionKey) && entry.incognito === true && entry.createdActor?.id
          ? [entry.createdActor]
          : [],
    );
  });
}
