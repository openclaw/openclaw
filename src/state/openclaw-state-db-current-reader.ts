import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  SqliteCoordinatorError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-lifecycle-errors.js";
import { runSqlitePinnedReadSnapshotSync } from "../infra/sqlite-pinned-read-snapshot.js";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
  runSqliteReadOperationSync,
  type SqliteSchemaFacts,
} from "../infra/sqlite-schema-facts.js";
import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
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
import {
  assertStateReadSchema,
  openOpenClawStateReadConnection,
  type OpenClawStateReadConnection,
} from "./openclaw-state-db-read-connection.js";
import { canReadWarmNativeSourceIndependently } from "./openclaw-state-db-readonly-reuse.js";
import { withCurrentOpenClawStateReadScope } from "./openclaw-state-db-readonly.js";
import { isExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import type { OpenClawStateReadOnlyDatabase } from "./openclaw-state-read.types.js";

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
      previous && !previous.legacyAdmission ? getAdmittedSqliteSchemaFacts(db) : undefined;
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
        assertStateReadSchema(db, pathname);
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
