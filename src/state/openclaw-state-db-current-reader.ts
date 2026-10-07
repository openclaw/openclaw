import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  SqliteCoordinatorError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-lifecycle-errors.js";
import {
  getSqlitePinnedReadSnapshot,
  runSqlitePinnedReadSnapshotSync,
} from "../infra/sqlite-pinned-read-snapshot.js";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
  readSqliteDataVersion,
  runSqliteReadOperationSync,
  type SqliteSchemaFacts,
} from "../infra/sqlite-schema-facts.js";
import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
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

/** One private live connection witnesses foreign commits without inheriting a caller's cursor. */
export async function prepareOpenClawStateCurrentReader(
  context: OpenClawStateWorkerContext,
): Promise<
  | {
      dataVersion(): number;
      read<T>(operation: (database: OpenClawStateReadOnlyDatabase) => T): T;
      dispose(): void;
    }
  | undefined
> {
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
  const connection = openOpenClawStateReadConnection(pathname, pathname, key);
  let active = true;
  let closed = false;
  let unregister = () => {};
  const close = () => {
    active = false;
    if (closed) {
      return;
    }
    if (!connection.close()) {
      throw new Error("Current shared-state reader cleanup is incomplete");
    }
    closed = true;
    unregister();
  };
  const resource = {
    async close(identity?: { key: string; canonicalPath: string }) {
      if (!identity || identity.key === key || identity.canonicalPath === canonicalPath) {
        close();
      }
    },
  };
  const assertCurrent = () => {
    if (!active || !connection.database.db.isOpen) {
      throw new Error("Current shared-state reader is closed");
    }
    assertSource();
    assertExistingDatabaseIdentity(pathname, key, birthtime);
    if (
      connection.database.db.isTransaction ||
      getSqlitePinnedReadSnapshot(connection.database.db)
    ) {
      throw new Error("Current shared-state reader cannot retain a transaction or snapshot");
    }
  };
  try {
    unregister = registerOpenClawStateDatabaseAsyncResource(resource);
    context.maintenanceScope?.own(resource, "shared-resources", () => resource.close());
    assertCurrent();
    return {
      dataVersion() {
        assertCurrent();
        const version = readSqliteDataVersion(connection.database.db);
        assertCurrent();
        return version;
      },
      read(operation) {
        const assertReadCurrent = () => {
          assertCurrent();
          const integrity = context.stateIntegrity;
          if (
            context.existingSchemaPath !== undefined &&
            (!integrity ||
              Atomics.load(new BigInt64Array(integrity.revision), 0) !== integrity.epoch ||
              Atomics.load(new BigInt64Array(integrity.proof), 0) === -1n)
          ) {
            throw new Error("Shared-state reader requires current worker integrity proof");
          }
        };
        assertReadCurrent();
        const read = () =>
          runWithSqliteWorkerStateContext(context, () =>
            runOpenClawStateCurrentReadConnection(
              connection,
              operation,
              undefined,
              "require-proof",
            ),
          );
        const result = context.runInCapturedSchemaScope
          ? context.runInCapturedSchemaScope(read)
          : read();
        assertReadCurrent();
        return result;
      },
      dispose() {
        try {
          close();
        } catch (error) {
          log.warn("Current shared-state reader cleanup failed; retaining cleanup custody", {
            error,
          });
        }
      },
    };
  } catch (error) {
    try {
      close();
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
    legacyAdmission: boolean;
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
    const previous = currentReaderSchemaAdmissions.get(db);
    // The schema owner observes foreign commits. Ordinary lease heartbeats keep
    // these facts; schema changes revoke them before this reader re-admits.
    const facts =
      previous && !previous.legacyAdmission
        ? runSqliteReadOperationSync(db, () => getAdmittedSqliteSchemaFacts(db))
        : undefined;
    if (
      !previous ||
      previous.admission !== openStateSchemaReadAdmission ||
      previous.legacyAdmission ||
      previous.facts !== facts
    ) {
      closeAdmission = openStateSchemaReadAdmission?.(db);
    }
    const existingSchema = isExistingOpenClawStateSchema(pathname, db);
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
          legacyAdmission: closeAdmission !== undefined,
        });
      }
    };
    runSqliteReadOperationSync(db, admit);
    result = runSqlitePinnedReadSnapshotSync(db, () => {
      const value = operation(connection.database);
      if (isPromiseLike(value)) {
        throw new SqliteCoordinatorError("SQLite current-authority read must remain synchronous");
      }
      return value;
    });
    // A foreign schema publication can arrive between admission and the query's
    // snapshot. Recheck its admitted facts before returning policy rows.
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
