import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { racePromiseWithAbortSignal } from "../../packages/retry/src/index.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { isMissingPathError } from "./errno.js";
import {
  canShareSqliteDatabaseAdmissions,
  hasSqliteDatabaseSchemaAdmissionForPath,
} from "./sqlite-database-admission.js";
import { inspectDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

type AdmissionTurnScope = { active: boolean };

const pending = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteDatabaseAdmissionTurns"),
  () => new Map<string, Promise<void>>(),
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
  const { promise: completion, resolve: completeTurn } = createDeferredCore();
  for (const key of keys) {
    pending.set(key, completion);
  }
  const release = () => {
    for (const key of keys) {
      if (pending.get(key) === completion) {
        pending.delete(key);
      }
    }
    completeTurn();
  };
  const ready = Promise.all(predecessors);
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
  signal?: AbortSignal,
): Promise<T> {
  if (current.getStore()?.active) {
    return operation();
  }
  const turn = reserveAdmissionTurn(locations, families);
  const run = () => {
    // Warm dispatch can lose schema admission while queued; nested work still belongs to this turn.
    const scope: AdmissionTurnScope = { active: true };
    return current.run(scope, async () => {
      try {
        return await operation();
      } finally {
        scope.active = false;
        turn?.release();
      }
    });
  };
  if (!turn) {
    return run();
  }
  return racePromiseWithAbortSignal(turn.ready, signal, (aborted) => aborted.reason).then(
    run,
    (error: unknown) => {
      // A cancelled waiter still carries its predecessors for later reservations.
      void turn.ready.then(turn.release);
      throw error;
    },
  );
}
