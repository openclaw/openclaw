import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { isMissingPathError } from "./errno.js";
import {
  canShareSqliteDatabaseAdmissions,
  hasSqliteDatabaseSchemaAdmissionForPath,
} from "./sqlite-database-admission.js";
import { inspectDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

type AdmissionTurn = {
  keys: ReadonlySet<string>;
  predecessors: Set<AdmissionTurn>;
  completion: Promise<void>;
  holding: boolean;
  references: number;
  releaseReference(): void;
};
type AdmissionTurnScope = { turns: readonly AdmissionTurn[]; active: boolean };

const pending = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteDatabaseAdmissionTurns"),
  () => new Map<string, AdmissionTurn>(),
);
const current = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteDatabaseAdmissionTurnContext"),
  () => new AsyncLocalStorage<AdmissionTurnScope>(),
);

function reserveAdmissionTurn(locations: string | readonly string[], families: readonly string[]) {
  if (!canShareSqliteDatabaseAdmissions()) {
    return undefined;
  }
  const keys = new Set(
    families.map((directory) => `family:${resolveIdentityPathViaExistingAncestorSync(directory)}`),
  );
  for (const location of typeof locations === "string" ? [locations] : locations) {
    let identity: ReturnType<typeof inspectDatabasePathIdentitySync>;
    try {
      // A native task can request a host writer after publishing its completed schema.
      if (hasSqliteDatabaseSchemaAdmissionForPath(location)) {
        continue;
      }
      identity = inspectDatabasePathIdentitySync(location);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
    // Discovery owns unavailable targets; they still share pathname and family ordering.
    const canonicalPath =
      identity?.canonicalPath ?? resolveIdentityPathViaExistingAncestorSync(location);
    keys.add(`path:${canonicalPath}`);
    if (identity) {
      keys.add(`${identity.key}:${identity.birthtime ?? ""}`);
    }
    keys.add(`family:${path.dirname(canonicalPath)}`);
  }
  if (keys.size === 0) {
    return undefined;
  }
  const scope = current.getStore();
  const parents = scope?.active ? scope.turns.filter((turn) => turn.holding) : [];
  const inherited = new Set(parents);
  const ownedKeys = new Set(parents.flatMap((turn) => [...turn.keys]));
  const ordered = [...keys].filter((key) => !ownedKeys.has(key)).toSorted();
  const predecessors = new Set<AdmissionTurn>();
  const waitsForParent = (turn: AdmissionTurn): boolean => {
    const search = [turn];
    const visited = new Set<AdmissionTurn>();
    for (const candidate of search) {
      if (inherited.has(candidate)) {
        return true;
      }
      if (!visited.has(candidate)) {
        visited.add(candidate);
        search.push(...candidate.predecessors);
      }
    }
    return false;
  };
  const search = ordered.flatMap((key) => pending.get(key) ?? []);
  const visited = new Set<AdmissionTurn>();
  for (const turn of search) {
    if (visited.has(turn)) {
      continue;
    }
    visited.add(turn);
    if (inherited.has(turn)) {
      continue;
    }
    if (waitsForParent(turn)) {
      // A queued caller cannot stand between an active turn and its nested callback.
      // Keep its other blockers, so parallel nested opens still validate each file once.
      search.push(...turn.predecessors);
    } else {
      predecessors.add(turn);
    }
  }
  const completion = createDeferredCore();
  const turn: AdmissionTurn = {
    keys: new Set(ordered),
    predecessors,
    completion: completion.promise,
    holding: false,
    references: 1,
    releaseReference() {
      if (--turn.references !== 0) {
        return;
      }
      turn.holding = false;
      for (const key of ordered) {
        if (pending.get(key) === turn) {
          pending.delete(key);
        }
      }
      completion.resolve();
      for (const parent of parents) {
        parent.releaseReference();
      }
    },
  };
  for (const parent of parents) {
    parent.references += 1;
  }
  for (const key of ordered) {
    pending.set(key, turn);
  }
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      turn.releaseReference();
    }
  };
  const ready = Promise.all([...predecessors].map((predecessor) => predecessor.completion)).then(
    () => {
      turn.holding = true;
      predecessors.clear();
    },
  );
  return { ready, release, turns: [...parents, turn] };
}

/** Only cold dispatch waits here; native getters never block the host on a worker's publication. */
export function acquireSqliteDatabaseAdmissionTurn(
  locations: string | readonly string[],
  families: readonly string[] = [],
): Promise<() => void> | undefined {
  const turn = reserveAdmissionTurn(locations, families);
  return turn?.ready.then(() => turn.release);
}

/** Known database locators are captured by their task owner before dispatch, never inferred from IPC. */
export function runWithSqliteDatabaseAdmissionTurn<T>(
  locations: readonly string[],
  operation: () => Promise<T>,
  families: readonly string[] = [],
): Promise<T> {
  const turn = reserveAdmissionTurn(locations, families);
  if (!turn) {
    return operation();
  }
  return turn.ready.then(() => {
    const scope: AdmissionTurnScope = { turns: turn.turns, active: true };
    return current.run(scope, async () => {
      try {
        return await operation();
      } finally {
        scope.active = false;
        turn.release();
      }
    });
  });
}
