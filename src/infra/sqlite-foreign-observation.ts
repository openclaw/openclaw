import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { registerNodeSqliteDisposeCallback } from "./kysely-sync-cache-state.js";
import { getSqlitePinnedReadSnapshot } from "./sqlite-pinned-read-snapshot.js";
import {
  readSqliteDataVersion,
  readSqliteForeignObservationRevision,
  registerSqliteSchemaMutationListener,
} from "./sqlite-schema-facts.js";

type Observation = { version: number; revision: number; epoch: number };
type Observer = { observe(): Observation; assertCurrent(observation?: Observation): void };

/** A use frame must end before yielding; all domains of one physical owner share its probe. */
export type SqliteForeignUse = { observe(observer: Observer): Observation | undefined };

const uses = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteForeignUse"),
  (): { current?: SqliteForeignUse } => ({}),
);

export function runSqliteForeignUse<T>(operation: (use: SqliteForeignUse) => T): T {
  const parent = uses.current;
  const observations = new Map<Observer, Observation>();
  let active = true;
  const use: SqliteForeignUse = {
    observe(observer) {
      if (!active) {
        throw new Error("SQLite foreign observation use has ended");
      }
      const previous = observations.get(observer);
      // A local callback can mutate or retire a handle even in one synchronous frame.
      if (previous) {
        observer.assertCurrent(previous);
        return previous;
      }
      const observation = observer.observe();
      observations.set(observer, observation);
      return observation;
    },
  };
  try {
    uses.current = parent ?? use;
    const result = operation(uses.current);
    if (isPromiseLike(result)) {
      throw new Error("SQLite foreign observation use must remain synchronous");
    }
    return result;
  } finally {
    uses.current = parent;
    active = false;
    observations.clear();
  }
}

/**
 * The database lifecycle owner supplies one dedicated handle per physical database.
 * This owns freshness only: complete facts, pending writes, and policy stay with
 * the domain owner. Installing a commit receipt never advances this baseline.
 */
export function createSqliteForeignObservation(database: DatabaseSync, assertSource: () => void) {
  let closed = false;
  let epoch = 0;
  let latest: Observation | undefined;
  const invalidate = () => {
    epoch += 1;
    latest = undefined;
  };
  registerNodeSqliteDisposeCallback(database, () => {
    closed = true;
    invalidate();
  });
  // Cache admission can replace derived schema facts without a schema mutation.
  registerSqliteSchemaMutationListener(database, invalidate);
  const revision = () => {
    if (closed || !database.isOpen) {
      throw new Error("SQLite foreign observation owner is closed");
    }
    assertSource();
    if (database.isTransaction || getSqlitePinnedReadSnapshot(database)) {
      throw new Error("SQLite foreign observation requires an unpinned handle");
    }
    const current = readSqliteForeignObservationRevision(database);
    if (current === undefined) {
      throw new Error("SQLite foreign observation requires a tracked, idle handle");
    }
    return current;
  };
  const observer: Observer = {
    assertCurrent(observation) {
      try {
        const current = revision();
        if (observation && (observation.epoch !== epoch || observation.revision !== current)) {
          throw new Error("SQLite foreign observation changed during use");
        }
      } catch (error) {
        invalidate();
        throw error;
      }
    },
    observe() {
      try {
        const before = revision();
        const version = readSqliteDataVersion(database);
        if (before !== revision()) {
          throw new Error("SQLite foreign observation changed during probe");
        }
        if (!latest || latest.version !== version || latest.revision !== before) {
          invalidate();
          latest = { version, revision: before, epoch };
        }
        return latest;
      } catch (error) {
        invalidate();
        throw error;
      }
    },
  };
  return {
    invalidate,
    createCertification(assertCurrent: () => void = () => {}) {
      let generation = 0;
      let certified: Observation | undefined;
      const retire = () => {
        generation += 1;
        certified = undefined;
      };
      const assertLive = () => {
        try {
          assertCurrent();
        } catch (error) {
          retire();
          throw error;
        }
      };
      return {
        invalidate: retire,
        beginRefresh(use?: SqliteForeignUse) {
          assertLive();
          retire();
          const refreshGeneration = generation;
          const before = use ? use.observe(observer) : observer.observe();
          assertLive();
          let pending = true;
          return {
            /** Call after the owner's coherent worker read, before installing any refreshed facts. */
            accept(finalUse?: SqliteForeignUse) {
              assertLive();
              if (!pending || refreshGeneration !== generation) {
                return false;
              }
              pending = false;
              const after = finalUse ? finalUse.observe(observer) : observer.observe();
              assertLive();
              if (after !== before) {
                return false;
              }
              certified = after;
              return true;
            },
          };
        },
        isCurrent(use: SqliteForeignUse) {
          assertLive();
          const observed = use.observe(observer);
          assertLive();
          if (certified && certified !== observed) {
            retire();
          }
          return certified !== undefined;
        },
      };
    },
  };
}
