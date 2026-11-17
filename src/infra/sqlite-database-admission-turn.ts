import path from "node:path";
import { racePromiseWithAbortSignal } from "../../packages/retry/src/index.js";
import { AsyncContext } from "../shared/async-context.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveIdentityPathViaExistingAncestor } from "./boundary-path.js";
import { isMissingPathError } from "./errno.js";
import {
  canShareSqliteDatabaseAdmissions,
  getSqliteDatabaseAdmissionIdentityForPath,
  hasSqliteDatabaseSchemaAdmissionForIdentity,
  prepareSqliteDatabaseAdmissionAsync,
} from "./sqlite-database-admission.js";
import type { DatabasePathIdentity } from "./sqlite-worker-identity.js";

type AdmissionTurnScope = { active: boolean };
export type PreparedSqliteReadAdmission = {
  readIdentities?: ReadonlyMap<string, DatabasePathIdentity>;
  physicalFamilies?: true;
};

const turns = resolveGlobalSingleton(Symbol.for("openclaw.sqliteDatabaseAdmissionTurns"), () => ({
  pending: new Map<string, Promise<void>>(),
  discovery: Promise.resolve(),
  discovering: 0,
}));
const current = new AsyncContext<AdmissionTurnScope>(
  Symbol.for("openclaw.sqliteDatabaseAdmissionTurnContext"),
);

function hasPublishedSchema(location: string): boolean {
  const identity = getSqliteDatabaseAdmissionIdentityForPath(location);
  return identity !== undefined && hasSqliteDatabaseSchemaAdmissionForIdentity(identity);
}

function reserveAdmissionTurn(keys: ReadonlySet<string>) {
  if (keys.size === 0) {
    return undefined;
  }
  const predecessors = new Set([...keys].flatMap((key) => turns.pending.get(key) ?? []));
  const { promise: completion, resolve: completeTurn } = createDeferredCore();
  for (const key of keys) {
    turns.pending.set(key, completion);
  }
  const release = () => {
    for (const key of keys) {
      if (turns.pending.get(key) === completion) {
        turns.pending.delete(key);
      }
    }
    completeTurn();
  };
  return { ready: Promise.all(predecessors), release };
}

type AdmissionPreparation =
  | PreparedSqliteReadAdmission
  | (() => Promise<PreparedSqliteReadAdmission>);

function prepareAdmissionTurn(
  locations: readonly string[],
  families: readonly string[],
  preparationSource?: AdmissionPreparation,
  assertCurrent: () => void = () => {},
) {
  // Capture invocation order before yielding, but release discovery immediately after enqueue.
  turns.discovering++;
  const preparation = turns.discovery.then(async () => {
    try {
      assertCurrent();
      const prepared =
        typeof preparationSource === "function" ? await preparationSource() : preparationSource;
      assertCurrent();
      const keys = new Set<string>();
      for (const directory of families) {
        const physical = prepared?.physicalFamilies
          ? directory
          : await resolveIdentityPathViaExistingAncestor(directory);
        assertCurrent();
        keys.add(`family:${physical}`);
      }
      const readIdentities = new Map(prepared?.readIdentities);
      for (const location of locations) {
        // Discovery returns physical facts; an explicit read scope still requests FIFO custody.
        if (
          (typeof preparationSource === "function" || !prepared?.readIdentities?.has(location)) &&
          hasPublishedSchema(location)
        ) {
          continue;
        }
        let identity: DatabasePathIdentity | undefined;
        try {
          identity = await prepareSqliteDatabaseAdmissionAsync({
            location,
            identity: prepared?.readIdentities?.get(location),
            assertCurrent,
          });
        } catch (error) {
          if (!isMissingPathError(error)) {
            throw error;
          }
        }
        const canonicalPath =
          identity?.canonicalPath ?? (await resolveIdentityPathViaExistingAncestor(location));
        assertCurrent();
        keys.add(`path:${canonicalPath}`);
        if (identity) {
          readIdentities.set(location, identity);
          keys.add(`${identity.key}:${identity.birthtime ?? ""}`);
        }
        if (!identity || !hasSqliteDatabaseSchemaAdmissionForIdentity(identity)) {
          keys.add(`family:${path.dirname(canonicalPath)}`);
        }
      }
      return { turn: reserveAdmissionTurn(keys), prepared: { readIdentities } };
    } finally {
      turns.discovering--;
    }
  });
  turns.discovery = preparation.then(
    () => {},
    () => {},
  );
  return preparation;
}

/** Only cold dispatch waits here; native getters never block the host on a worker's publication. */
export function acquireSqliteDatabaseAdmissionTurn(
  locations: string | readonly string[],
  families: readonly string[] = [],
  prepared?: PreparedSqliteReadAdmission,
  assertCurrent?: () => void,
): Promise<() => void> | undefined {
  const paths = typeof locations === "string" ? [locations] : locations;
  if (
    current.getStore()?.active ||
    !canShareSqliteDatabaseAdmissions() ||
    (!turns.discovering && !prepared && !families.length && paths.every(hasPublishedSchema))
  ) {
    return undefined;
  }
  return prepareAdmissionTurn(paths, families, prepared, assertCurrent).then(async ({ turn }) => {
    await turn?.ready;
    return turn?.release ?? (() => {});
  });
}

/** Known database locators are captured by their task owner before dispatch, never inferred from IPC. */
export function runWithSqliteDatabaseAdmissionTurn<T>(
  locations: readonly string[],
  operation: (prepared?: PreparedSqliteReadAdmission) => Promise<T>,
  families: readonly string[] = [],
  signal?: AbortSignal,
  prepared?: AdmissionPreparation,
  assertCurrent?: () => void,
): Promise<T> {
  if (current.getStore()?.active || !canShareSqliteDatabaseAdmissions()) {
    return typeof prepared === "function" ? prepared().then(operation) : operation(prepared);
  }
  const run = (
    turn: ReturnType<typeof reserveAdmissionTurn>,
    facts: PreparedSqliteReadAdmission | undefined,
  ) => {
    // Warm dispatch can lose schema admission while queued; nested work still belongs to this turn.
    const scope: AdmissionTurnScope = { active: true };
    return current.run(scope, async () => {
      try {
        return await operation(facts);
      } finally {
        scope.active = false;
        turn?.release();
      }
    });
  };
  if (!turns.discovering && !prepared && !families.length && locations.every(hasPublishedSchema)) {
    return run(undefined, undefined);
  }
  const assertPreparing = () => {
    signal?.throwIfAborted();
    assertCurrent?.();
  };
  return prepareAdmissionTurn(locations, families, prepared, assertPreparing).then(
    ({ turn, prepared: facts }) => {
      if (!turn) {
        return run(undefined, facts);
      }
      return racePromiseWithAbortSignal(turn.ready, signal, (aborted) => aborted.reason).then(
        () => run(turn, facts),
        (error: unknown) => {
          // A cancelled waiter still carries its predecessors for later reservations.
          void turn.ready.then(turn.release);
          throw error;
        },
      );
    },
  );
}
