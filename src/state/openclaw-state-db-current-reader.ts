import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { readSqliteDatabaseWriteRevision } from "../infra/sqlite-database-admission.js";
import {
  SqliteCoordinatorError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-lifecycle-errors.js";
import { getSqlitePinnedReadSnapshot } from "../infra/sqlite-pinned-read-snapshot.js";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
  runSqliteReadOperationSync,
  type SqliteSchemaFacts,
} from "../infra/sqlite-schema-facts.js";
import { assertTransactionUsable, runSqliteReadSnapshotSync } from "../infra/sqlite-transaction.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getStateRuntimeSchemaAdmission } from "./openclaw-state-db-admission.js";
import {
  getOpenClawDatabaseMaintenanceResourceScope,
  getOpenClawDatabaseMaintenanceScope,
} from "./openclaw-state-db-async-lifecycle.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  openClawStateDatabaseCache,
  registerOpenClawStateDatabaseAsyncResource,
  requireOpenClawStateDatabaseIdentity,
  retainOpenClawStateDatabaseForIndependentRead,
} from "./openclaw-state-db-cache.js";
import type {
  OpenClawStateDatabaseOptions,
  OpenClawStateSchemaReadAdmission,
} from "./openclaw-state-db-contract.js";
import type { OpenClawStateIntegrityPolicy } from "./openclaw-state-db-integrity-admission.js";
import {
  assertStateReadSchema,
  openOpenClawStateReadConnection,
  type OpenClawStateReadConnection,
} from "./openclaw-state-db-read-connection.js";
import { admitStateReadSchemaFacts } from "./openclaw-state-db-read-schema.js";
import { canReadWarmNativeSourceIndependently } from "./openclaw-state-db-readonly-reuse.js";
import {
  executeExistingOpenClawStateRead,
  withCurrentOpenClawStateReadScope,
} from "./openclaw-state-db-readonly.js";
import { isExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import { existingPathOrUndefined } from "./openclaw-state-db.paths.js";
import type { OpenClawStateReadOnlyDatabase } from "./openclaw-state-read.types.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

const log = createSubsystemLogger("state/db");

type CurrentReader = {
  connection: OpenClawStateReadConnection;
  canonicalPath: string;
  users: number;
  retiring: boolean;
  closed: boolean;
  close(): void;
};

const currentReaders = resolveGlobalSingleton(
  Symbol.for("openclaw.stateCurrentReaders"),
  () => new Map<string, CurrentReader>(),
);

/** One private live connection per physical store, independent of caller cursors. */
export async function prepareOpenClawStateCurrentReader(context: OpenClawStateWorkerContext) {
  const pathname = context.admission.databasePath;
  const { key, canonicalPath, birthtime } = context.admission.identity;
  const signal = getAsyncWorkSignal();
  const assertSource = () => {
    signal?.throwIfAborted();
    getAsyncWorkSignal()?.throwIfAborted();
    context.maintenanceScope?.assertReadAdmission();
    context.admission.assertCurrent();
    openClawStateDatabaseCache.assertOpenClawStateDatabaseOpenAllowed(pathname, "cached-read");
  };
  assertSource();
  if (!key.startsWith("file:")) {
    if (existingPathOrUndefined(pathname)) {
      throw new Error("Current shared-state reader source was created after capture");
    }
    return undefined;
  }
  assertExistingDatabaseIdentity(pathname, key, birthtime);
  const physicalKey = `${key}:${birthtime ?? ""}`;
  const previous = currentReaders.get(physicalKey);
  if (previous?.retiring) {
    previous.close();
  }
  if (!currentReaders.has(physicalKey)) {
    const admitted = await executeExistingOpenClawStateRead(
      { path: pathname, env: context.environment },
      { type: "admit" },
      { context, current: true, signal },
    );
    assertSource();
    assertExistingDatabaseIdentity(pathname, key, birthtime);
    if (!admitted?.ok || admitted.type !== "admit") {
      throw new Error("Current shared-state reader admission did not settle");
    }
  }
  let reader = currentReaders.get(physicalKey);
  if (!reader) {
    const connection = openOpenClawStateReadConnection(pathname, pathname, key);
    let unregister = () => {};
    const opened: CurrentReader = {
      connection,
      canonicalPath,
      users: 0,
      retiring: false,
      closed: false,
      close() {
        if (opened.closed) {
          return;
        }
        opened.retiring = true;
        if (!connection.close()) {
          throw new Error("Current shared-state reader cleanup is incomplete");
        }
        opened.closed = true;
        if (currentReaders.get(physicalKey) === opened) {
          currentReaders.delete(physicalKey);
        }
        unregister();
      },
    };
    try {
      unregister = registerOpenClawStateDatabaseAsyncResource({
        async close(identity) {
          if (!identity || identity.key === key || identity.canonicalPath === canonicalPath) {
            opened.close();
          }
        },
      });
    } catch (error) {
      try {
        opened.close();
      } catch (cleanupError) {
        throwSqliteLifecycleErrors(
          [error, cleanupError],
          "Current shared-state reader registration and cleanup failed",
        );
      }
      throw error;
    }
    currentReaders.set(physicalKey, opened);
    reader = opened;
  }
  const retained = reader;
  retained.users += 1;
  let active = true;
  const assertCurrent = () => {
    if (!active || retained.retiring || !retained.connection.database.db.isOpen) {
      throw new Error("Current shared-state reader is closed");
    }
    assertSource();
    const integrity = context.stateIntegrity;
    if (
      (integrity && Atomics.load(new BigInt64Array(integrity.revision), 0) !== integrity.epoch) ||
      (context.existingSchemaPath !== undefined &&
        (!integrity || Atomics.load(new BigInt64Array(integrity.proof), 0) === -1n))
    ) {
      throw new Error("Shared-state reader requires current worker integrity proof");
    }
    try {
      assertExistingDatabaseIdentity(retained.canonicalPath, key, birthtime);
      assertExistingDatabaseIdentity(pathname, key, birthtime);
    } catch (error) {
      // Restoring an alias cannot revive borrowers after an observed source replacement.
      try {
        retained.close();
      } catch (cleanupError) {
        throwSqliteLifecycleErrors(
          [error, cleanupError],
          "Current shared-state reader identity and cleanup failed",
        );
      }
      throw error;
    }
    if (
      retained.connection.database.db.isTransaction ||
      getSqlitePinnedReadSnapshot(retained.connection.database.db)
    ) {
      throw new Error("Current shared-state reader cannot retain a transaction or snapshot");
    }
  };
  const release = () => {
    if (active) {
      active = false;
      retained.users -= 1;
    }
    if (retained.users === 0 && !retained.closed) {
      retained.close();
    }
  };
  const resource = {
    async close() {
      release();
    },
  };
  try {
    context.maintenanceScope?.own(resource, "shared-resources", () => resource.close());
    assertCurrent();
    return {
      writeRevision() {
        assertCurrent();
        const revision = readSqliteDatabaseWriteRevision(retained.connection.database.db);
        assertCurrent();
        return revision;
      },
      read<T>(operation: (database: OpenClawStateReadOnlyDatabase) => T): T {
        assertCurrent();
        if (
          context.existingSchemaPath !== undefined &&
          !getStateRuntimeSchemaAdmission(retained.connection.database.db)
        ) {
          throw new Error("Shared-state reader requires current worker integrity proof");
        }
        const read = () =>
          runWithSqliteWorkerStateContext(context, () =>
            runOpenClawStateCurrentReadConnection(
              retained.connection,
              operation,
              undefined,
              "require-proof",
            ),
          );
        const result = context.runInCapturedSchemaScope
          ? context.runInCapturedSchemaScope(read)
          : read();
        assertCurrent();
        return result;
      },
      dispose() {
        try {
          release();
        } catch (error) {
          log.warn("Current shared-state reader cleanup failed; retaining cleanup custody", {
            error,
          });
        }
      },
    };
  } catch (error) {
    try {
      release();
    } catch (cleanupError) {
      throwSqliteLifecycleErrors(
        [error, cleanupError],
        "Current shared-state reader admission and cleanup failed",
      );
    }
    throw error;
  }
}

/** Mutating maintenance can retain an independent current reader under its exact source lifetime. */
export function createOpenClawStateCurrentWarmReader<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  options: OpenClawStateDatabaseOptions,
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission,
): () => { available: false } | { available: true; value: T } {
  let bound:
    | {
        path: string;
        scope: ReturnType<typeof getOpenClawDatabaseMaintenanceScope>;
        read(): T;
      }
    | undefined;
  return () => {
    return withCurrentOpenClawStateReadScope(options, (pathname) => {
      const scope = getOpenClawDatabaseMaintenanceScope();
      if (!scope?.ownsSchemaMaintenance || (bound && bound.scope !== scope)) {
        return { available: false };
      }
      if (bound && bound.path !== pathname) {
        throw new Error("Current shared-state reader cannot change its database before cleanup");
      }
      if (!bound) {
        const native = openClawStateDatabaseCache.getCachedOpenClawStateDatabase(pathname, {
          readOnly: true,
        });
        if (!native?.db.isOpen) {
          return { available: false };
        }
        const sourceScope = getOpenClawDatabaseMaintenanceResourceScope(native.db);
        if (sourceScope && sourceScope !== scope) {
          return { available: false };
        }
        const identity = requireOpenClawStateDatabaseIdentity(native);
        if (!canReadWarmNativeSourceIndependently(native, pathname, identity.key)) {
          return { available: false };
        }
        const admission = captureOpenClawStateDatabaseReadAdmission(pathname);
        const retained = retainOpenClawStateDatabaseForIndependentRead(pathname, "cached-read");
        if (!retained) {
          return { available: false };
        }
        let connection: ReturnType<typeof openOpenClawStateReadConnection>;
        try {
          connection = openOpenClawStateReadConnection(pathname, pathname, identity.key);
        } catch (error) {
          try {
            retained.release();
          } catch (cleanupError) {
            throwSqliteLifecycleErrors(
              [error, cleanupError],
              "Current shared-state reader open and cleanup failed.",
            );
          }
          throw error;
        }
        let active = true;
        let unregister = () => {};
        const assertCurrent = () => {
          if (!active) {
            throw new Error("Current shared-state reader is closed");
          }
          scope?.assertReadAdmission();
          admission.assertCurrent();
          retained.assertCurrent();
          assertExistingDatabaseIdentity(pathname, identity.key);
          openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(
            pathname,
            options.env ?? process.env,
          );
        };
        const reader = {
          path: pathname,
          scope,
          read() {
            assertCurrent();
            const result = runOpenClawStateCurrentReadConnection(
              connection,
              operation,
              openStateSchemaReadAdmission,
            );
            assertCurrent();
            retained.observe();
            return result;
          },
        };
        const resource = {
          async close(closingIdentity?: { key: string; canonicalPath: string }) {
            if (
              !active ||
              (closingIdentity &&
                closingIdentity.key !== identity.key &&
                closingIdentity.canonicalPath !== identity.canonicalPath)
            ) {
              return;
            }
            connection.close();
            retained.release();
            active = false;
            if (bound === reader) {
              bound = undefined;
            }
            unregister();
          },
        };
        unregister = registerOpenClawStateDatabaseAsyncResource(resource);
        scope?.own(resource, "shared-resources", () => resource.close());
        bound = reader;
      }
      return { available: true, value: bound.read() };
    });
  };
}

const currentReaderSchemaAdmissions = new WeakMap<
  DatabaseSync,
  {
    facts: SqliteSchemaFacts;
    existingSchema: boolean;
    admission?: OpenClawStateSchemaReadAdmission;
  }
>();

/** An independent current reader keeps composite policy rows in one bounded snapshot. */
function runOpenClawStateCurrentReadConnection<T>(
  connection: OpenClawStateReadConnection,
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission,
  integrityPolicy?: OpenClawStateIntegrityPolicy,
): T {
  const { db, path: pathname } = connection.database;
  let closeAdmission: (() => void) | undefined;
  const errors: unknown[] = [];
  let result!: T;
  try {
    // Explicit Doctor inspection retains its checks; ordinary runtime reads have no callback.
    closeAdmission = openStateSchemaReadAdmission?.(db);
    const existingSchema = isExistingOpenClawStateSchema(pathname, db);
    if (openStateSchemaReadAdmission) {
      admitStateReadSchemaFacts(db, pathname);
    }
    const admit = () => {
      const current = getAdmittedSqliteSchemaFacts(db);
      const accepted = currentReaderSchemaAdmissions.get(db);
      if (
        !current ||
        accepted?.facts !== current ||
        accepted.existingSchema !== existingSchema ||
        accepted.admission !== openStateSchemaReadAdmission
      ) {
        assertStateReadSchema(db, pathname, integrityPolicy);
        admitSqliteSchema(db);
        const admitted = getAdmittedSqliteSchemaFacts(db);
        if (!admitted) {
          throw new Error("Current shared-state reader could not retain schema admission");
        }
        currentReaderSchemaAdmissions.set(db, {
          facts: admitted,
          existingSchema,
          admission: openStateSchemaReadAdmission,
        });
      }
    };
    runSqliteReadOperationSync(db, admit);
    result = runSqliteReadSnapshotSync(db, () => {
      const value = operation(connection.database);
      if (isPromiseLike(value)) {
        throw new SqliteCoordinatorError("SQLite current-authority read must remain synchronous");
      }
      return value;
    });
    // Local migration publication can replace the admitted facts during the read.
    runSqliteReadOperationSync(db, admit);
  } catch (error) {
    errors.push(error);
  }
  try {
    closeAdmission?.();
  } catch (error) {
    errors.push(error);
  }
  try {
    assertTransactionUsable(db);
  } catch (error) {
    errors.push(error);
  }
  throwSqliteLifecycleErrors(errors, "Current shared-state read and schema cleanup failed.");
  return result;
}
