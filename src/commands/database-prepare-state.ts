import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import { getDatabaseEngineInput } from "../infra/database-engine/context.js";
import { readBackupEngine } from "../infra/database-engine/physical-store.js";
import { postgresStoreNamespace } from "../infra/database-engine/postgres-schema.js";
import { withPostgresConnection } from "../infra/database-engine/postgres-store-metadata.js";
import { assertDatabasePortStartupAllowed } from "../infra/database-port-recovery.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import { acquireStateDatabaseSchemaLease } from "../infra/gateway-state-owner.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { openExistingStatePostgresConnection } from "../state/openclaw-state-db-engine.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readConfigSnapshotForEngineSelection } from "./config-preflight-snapshot.js";

class StatePreparationError extends Error {}

/** Prepare only the explicitly selected new shared store; never repair unknown PostgreSQL data. */
export async function prepareDatabaseState(options: {
  expectedStoreId: string;
  expectedNamespace: string;
}) {
  const expectedStoreId = z.uuid().parse(options.expectedStoreId);
  const expectedNamespace = z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/u)
    .parse(options.expectedNamespace);
  let phase = "core-configuration";
  try {
    // Core config selection does not require the not-yet-created PostgreSQL metadata.
    const snapshot = await readConfigSnapshotForEngineSelection();
    const input = getDatabaseEngineInput("state");
    if (!snapshot.valid || !input) {
      throw new StatePreparationError(
        "Shared-state preparation requires valid PostgreSQL configuration.",
      );
    }
    const pathname = resolveOpenClawStateSqlitePath(process.env);
    assertDatabasePortStartupAllowed(resolveStateDir());
    if (
      postgresStoreNamespace(input.schemaPrefix, "state", expectedStoreId) !== expectedNamespace
    ) {
      throw new StatePreparationError(
        "Expected namespace does not match the configured shared-state identity.",
      );
    }
    phase = "schema-custody";
    const acquired = acquireStateDatabaseSchemaLease(pathname, { busyTimeoutMs: 0 });
    await using lease = {
      ...acquired,
      async [Symbol.asyncDispose]() {
        // Failed native close retains physical custody instead of admitting another writer.
        try {
          await closeOpenClawStateDatabaseByPathAsync(pathname);
        } catch {
          throw new StatePreparationError(
            "Shared-state resources did not close; ownership remains retained.",
          );
        }
        acquired.release();
      },
    };
    lease.assertCurrent();
    phase = "anchor-validation";
    const anchor = readBackupEngine(pathname);
    if (
      anchor.engine !== "postgres" ||
      anchor.storeId !== expectedStoreId ||
      anchor.namespace !== expectedNamespace
    ) {
      throw new StatePreparationError(
        "Shared-state anchor does not match the expected store and namespace.",
      );
    }
    phase = "namespace-inspection";
    const exists = await withPostgresConnection(input, async (client) => {
      // Catalog-only discovery distinguishes new storage from incomplete existing storage.
      const result = await client.query(
        "SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1",
        [expectedNamespace],
      );
      return result.rows.length !== 0;
    });
    lease.assertCurrent();
    if (!exists) {
      phase = "writable-bootstrap";
      lease.run(() =>
        withOpenClawStateStartupMigrationCheckpointDatabase(() => {}, {
          env: process.env,
          sealOnClose: true,
        }),
      );
    }
    phase = "ready-validation";
    // Existing-only admission refuses missing metadata, wrong identity or catalog drift.
    // It also confirms a newly bootstrapped store without changing its anchor.
    lease.run(() => {
      const reader = openExistingStatePostgresConnection(pathname);
      if (!reader) {
        throw new StatePreparationError("Matching PostgreSQL shared state is unavailable.");
      }
      using readerCustody = {
        database: reader.database,
        [Symbol.dispose]() {
          if (!reader.close()) {
            throw new StatePreparationError("Shared-state reader did not close.");
          }
        },
      };
      if (
        readStateSchemaContentVersion(readerCustody.database.db) !== OPENCLAW_STATE_SCHEMA_VERSION
      ) {
        throw new StatePreparationError("Shared state is not ready for this installed version.");
      }
    });
    return {
      ok: true,
      status: exists ? "ready" : "prepared",
      path: pathname,
      storeId: expectedStoreId,
      namespace: expectedNamespace,
      schemaVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    };
  } catch (error) {
    if (error instanceof StatePreparationError) {
      throw error;
    }
    // Keep the failed owner boundary and nested cause, using the existing
    // credential redactor before bounding diagnostics for CLI/operator transport.
    const detail = formatErrorMessageWithCode(error).slice(0, 2048);
    throw new StatePreparationError(`Shared-state preparation ${phase} failed: ${detail}`);
  }
}
