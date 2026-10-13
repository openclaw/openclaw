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
  completion: Promise<void>;
};
type AdmissionTurnScope = { active: boolean };

const pending = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteDatabaseAdmissionTurns"),
  () => new Map<string, AdmissionTurn>(),
);
const current = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteDatabaseAdmissionTurnContext"),
  () => new AsyncLocalStorage<AdmissionTurnScope>(),
);

function reserveAdmissionTurn(locations: string | readonly string[], families: readonly string[]) {
  // Nested dispatch belongs to the outer turn; it must not queue behind its own callers.
  if (current.getStore()?.active || !canShareSqliteDatabaseAdmissions()) {
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
  const predecessors = new Set([...keys].flatMap((key) => pending.get(key) ?? []));
  const completion = createDeferredCore();
  const turn: AdmissionTurn = {
    keys,
    completion: completion.promise,
  };
  for (const key of keys) {
    pending.set(key, turn);
  }
  const release = () => {
    for (const key of turn.keys) {
      if (pending.get(key) === turn) {
        pending.delete(key);
      }
    }
    completion.resolve();
  };
  const ready = Promise.all([...predecessors].map((predecessor) => predecessor.completion));
  return { ready, release };
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
    const scope: AdmissionTurnScope = { active: true };
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
