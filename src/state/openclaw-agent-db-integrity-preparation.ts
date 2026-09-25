import { AsyncLocalStorage } from "node:async_hooks";
import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isMainThread } from "node:worker_threads";
import { readSqliteDataVersion, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
  type SqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import {
  runSqliteIntegrityCheckSync,
  type SqliteIntegrityCheck,
  type SqliteIntegrityOperation,
} from "../infra/sqlite-integrity.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "./openclaw-agent-db-readonly-scope.js";
import {
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import {
  adoptOpenClawAgentDatabaseValidation,
  getOpenClawAgentDatabaseValidation,
  type OpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";

const PREPARATION_CHANGED = "AGENT_INTEGRITY_PREPARATION_CHANGED";
const preparedIntegrity = new AsyncLocalStorage<PreparedAgentIntegrity>();

export function isAgentIntegrityPreparationChanged(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === PREPARATION_CHANGED;
}

/** Native read custody is private to the canonical opener and never grants write authority. */
class PreparedAgentIntegrity {
  private readonly identity;
  private readonly schema;
  private readonly recoveryGeneration?: SqliteFileGeneration;
  private version = 0;
  private outcome: { failure?: { error: unknown } } | undefined;
  private consumed = false;
  private borrowedValidation: OpenClawAgentDatabaseValidation | undefined;

  constructor(
    private readonly scope: OpenClawAgentDatabaseReadOnlyScope,
    private readonly retained: Extract<
      ReturnType<OpenClawAgentDatabaseReadOnlyScope["retain"]>,
      { found: true }
    >,
    assertAllowed: () => void,
    validation?: OpenClawAgentDatabaseValidation,
  ) {
    this.identity = readOpenClawAgentDatabaseIdentity(retained.database);
    if (retained.database.rollbackRecovery) {
      assertAllowed();
      this.assertPhysicalCurrent();
      this.recoveryGeneration = readStableSqliteFileGeneration(retained.database.path);
      this.assertPhysicalCurrent();
      assertAllowed();
      return;
    }
    this.schema = readExistingAgentSchemaMeta(retained.database.db);
    // Ordinary close preserves verified local proof; bind it to this retained reader before reuse.
    this.borrowedValidation =
      getOpenClawAgentDatabaseValidation(retained.database) ??
      (validation && adoptOpenClawAgentDatabaseValidation(retained.database, validation)
        ? validation
        : undefined);
    let before: number;
    do {
      assertAllowed();
      this.assertResourceCurrent();
      before = readSqliteDataVersion(retained.database.db);
      this.outcome = undefined;
      if (
        this.borrowedValidation &&
        Atomics.load(new Int32Array(this.borrowedValidation.valid), 0) !== 1
      ) {
        this.borrowedValidation = undefined;
      }
      try {
        if (!this.borrowedValidation) {
          runSqliteIntegrityCheckSync({
            database: retained.database.db,
            databaseLabel: retained.database.path,
          });
          this.outcome = {};
        }
      } catch (error) {
        this.outcome = { failure: { error } };
      }
      this.assertResourceCurrent();
      assertAllowed();
      this.version = readSqliteDataVersion(retained.database.db);
    } while (before !== this.version);
  }

  private assertPhysicalCurrent(): void {
    const { database, claim } = this.retained;
    claim.assertCurrent();
    const file = statSync(database.path, { bigint: true });
    if (
      database.db.location() !== this.identity.filename ||
      `${file.dev}:${file.ino}` !== this.identity.identity ||
      file.birthtimeNs.toString() !== this.identity.birthtime
    ) {
      throw new Error("Prepared agent database physical source changed");
    }
  }

  private assertResourceCurrent(): void {
    this.assertPhysicalCurrent();
    const { database } = this.retained;
    assertSupportedAgentSchemaVersion(database.db, database.path);
    const schema = readExistingAgentSchemaMeta(database.db);
    assertExistingAgentSchemaOwner(schema, database.agentId, database.path);
    if (!isDeepStrictEqual(schema, this.schema)) {
      throw new Error("Prepared agent database schema owner changed");
    }
  }

  assertCurrent(): void {
    if (this.recoveryGeneration) {
      this.assertPhysicalCurrent();
      if (
        !sameSqliteFileGeneration(
          this.recoveryGeneration,
          readStableSqliteFileGeneration(this.retained.database.path),
        )
      ) {
        throw Object.assign(new Error("Agent recovery source changed before promotion"), {
          code: PREPARATION_CHANGED,
        });
      }
      return;
    }
    this.assertResourceCurrent();
    if (
      readSqliteDataVersion(this.retained.database.db) !== this.version ||
      (this.borrowedValidation &&
        Atomics.load(new Int32Array(this.borrowedValidation.valid), 0) !== 1)
    ) {
      throw Object.assign(new Error("Agent integrity preparation changed before promotion"), {
        code: PREPARATION_CHANGED,
      });
    }
  }

  private assertNativeSource(database: DatabaseSync): void {
    const identity = readOpenClawAgentDatabaseIdentity({ db: database });
    if (
      identity.identity !== this.identity.identity ||
      identity.birthtime !== this.identity.birthtime ||
      identity.filename !== this.identity.filename
    ) {
      throw new Error("Agent integrity promotion differs from its retained physical source");
    }
  }

  assertOpenSource(database: DatabaseSync): void {
    this.assertCurrent();
    this.assertNativeSource(database);
  }

  consume(check: SqliteIntegrityCheck): { failure?: { error: unknown } } | undefined {
    if (this.consumed) {
      return undefined;
    }
    if (this.recoveryGeneration) {
      // Native rollback has changed the bytes; the admitted canonical gate still checks them fully.
      this.assertPhysicalCurrent();
    } else {
      this.assertCurrent();
    }
    this.assertNativeSource(check.database);
    this.consumed = true;
    return this.outcome;
  }

  close(): void {
    closePreparedAgentIntegrity(this.scope, this.retained.claim.release);
  }
}

function closePreparedAgentIntegrity(
  scope: OpenClawAgentDatabaseReadOnlyScope,
  release: () => void,
  priorFailure?: { error: unknown },
): void {
  const failures: unknown[] = priorFailure ? [priorFailure.error] : [];
  for (const close of [release, () => scope.close()]) {
    try {
      close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 1) {
    throw createSqliteLifecycleAggregateError(
      failures,
      "Agent integrity preparation and cleanup failed",
      failures[0],
    );
  }
  if (failures.length === 1) {
    throw failures[0];
  }
}

export function prepareAgentIntegrityReadOnly(
  options: OpenClawAgentDatabaseOptions,
  assertAllowed: () => void,
  validation?: OpenClawAgentDatabaseValidation,
) {
  if (isMainThread) {
    throw new Error("Agent integrity preparation requires its native Worker");
  }
  const scope = new OpenClawAgentDatabaseReadOnlyScope(false, true);
  let release: (() => void) | undefined;
  try {
    const retained = scope.retain(options);
    if (!retained.found) {
      scope.close();
      return undefined;
    }
    release = retained.claim.release;
    return new PreparedAgentIntegrity(scope, retained, assertAllowed, validation);
  } catch (error) {
    closePreparedAgentIntegrity(scope, () => release?.(), { error });
    throw error;
  }
}

export function withPreparedAgentIntegrity<T>(
  preparation: PreparedAgentIntegrity | undefined,
  open: () => T,
): T {
  preparation?.assertCurrent();
  return preparation ? preparedIntegrity.run(preparation, open) : open();
}

/** Retained preparation may reopen its captured file, never create a successor. */
export function resolveAgentDatabaseOpeningLocation(pathname: string): string {
  return preparedIntegrity.getStore() ? resolveExistingSqliteFileUri(pathname) : pathname;
}

/** Fence the new native connection before its first query can recover a rollback journal. */
export function assertPreparedAgentDatabaseOpenSource(database: DatabaseSync): void {
  preparedIntegrity.getStore()?.assertOpenSource(database);
}

/** Only the first matching canonical gate consumes the retained read; repairs verify afresh. */
export function runAgentDatabaseIntegrityOperationSync<T>(
  operation: SqliteIntegrityOperation<T>,
  assertCurrent?: (database?: DatabaseSync) => void,
): T {
  assertAgentDatabaseOpenAuthority(operation, () => assertCurrent?.());
  let step = operation.next();
  while (!step.done) {
    const check = step.value;
    let prepared: ReturnType<PreparedAgentIntegrity["consume"]>;
    assertAgentDatabaseOpenAuthority(operation, () => {
      prepared = preparedIntegrity.getStore()?.consume(check);
    });
    let failure: { error: unknown } | undefined;
    try {
      if (prepared?.failure) {
        throw prepared.failure.error;
      }
      if (!prepared) {
        runSqliteIntegrityCheckSync(check);
      }
    } catch (error) {
      failure = { error };
    }
    // A rejected owner must not turn a stale check failure into schema repair.
    const checkedDatabase = check.database;
    assertAgentDatabaseOpenAuthority(operation, () => assertCurrent?.(checkedDatabase));
    step = failure ? operation.throw(failure.error) : operation.next();
  }
  return step.value;
}

/** Refusal must unwind ownership without entering corruption repair or changing its caller error. */
export function assertAgentDatabaseOpenAuthority<T>(
  operation: SqliteIntegrityOperation<T>,
  assertCurrent?: () => void,
): void {
  try {
    assertCurrent?.();
  } catch (error) {
    const refusal = new Error("Agent database open authority was refused", { cause: error });
    try {
      operation.throw(refusal);
    } catch (cleanupError) {
      if (cleanupError !== refusal) {
        throw new AggregateError(
          [error, cleanupError],
          `Agent database authority and cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          {
            cause: cleanupError,
          },
        );
      }
    }
    throw error;
  }
}
