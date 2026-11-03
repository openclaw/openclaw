import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import { formatErrorMessage } from "./errors.js";
import { assertStateDatabaseAccessAllowed } from "./gateway-state-owner.js";
import type { PostgresSyncConnection } from "./postgres-sync/connection.js";
import { parseSqliteFileGeneration } from "./sqlite-file-generation.js";
import {
  createSqliteLifecycleAggregateError,
  SqliteCoordinatorError,
} from "./sqlite-lifecycle-errors.js";
import {
  resolveSqliteInspectionSignal,
  runSqliteReadOnlyWorker,
  runSqliteReadOnlyWorkerSync,
} from "./sqlite-readonly-worker.js";
import { truncateSqliteWal } from "./sqlite-wal-checkpoint.js";
import { readMatchingUpdateDatabaseGeneration } from "./update-database-generations.js";
import { resolveUpdateSqlitePath } from "./update-database-path.js";

export type UpdateDoctorMigrationCapture = {
  /** Captured SQLite sources admitted by this Doctor session. */
  openedSqlitePaths?: Set<string>;
  expected(pathname: string): string | null | undefined;
  assertCurrent(): void;
  accept(pathname: string, before: string | null, after: string | null): void;
  refuse(message: string): void;
};

type MigrationSource = {
  path: string;
  generation: string;
  assertCurrent(this: void): void;
};
type DoctorMigrationBackup = (
  db: DatabaseSync,
  options: { path: string; env: NodeJS.ProcessEnv; tables: readonly string[] },
) => { capture: MigrationSource; backupPath: string };
type DoctorMigrationFullBackup = { path: string; generation?: string };
const captures = new AsyncLocalStorage<{
  capture?: UpdateDoctorMigrationCapture;
  source?: MigrationSource;
  companions?: readonly MigrationSource[];
  assertMigrationCurrent?: () => void;
  backup?: DoctorMigrationBackup;
  fullBackups?: Map<string, DoctorMigrationFullBackup>;
}>();

/** Doctor's existing maintenance interval owns the publication receipt. */
export function runWithUpdateDoctorMigrationCapture<T>(
  capture: UpdateDoctorMigrationCapture,
  operation: () => T,
): T {
  // A standalone Doctor backup must not replace its installed updater's inventory.
  const context = captures.getStore();
  return context?.capture
    ? operation()
    : captures.run({ ...context, capture }, () => withArtifactPreservingStateReads(operation));
}

/** Standalone Doctor supplies its existing artifact owner without a command-layer import. */
export function runWithDoctorMigrationBackup<T>(
  backup: DoctorMigrationBackup,
  operation: () => T,
): T {
  return captures.run({ ...captures.getStore(), backup, fullBackups: new Map() }, operation);
}

/** Only the general Doctor backup owner admits full images for this maintenance run. */
export function recordDoctorMigrationFullBackup(
  sourcePath: string,
  backup: DoctorMigrationFullBackup,
): void {
  captures.getStore()?.fullBackups?.set(realpathSync.native(sourcePath), backup);
}

export function getDoctorMigrationFullBackup(
  sourcePath: string,
): DoctorMigrationFullBackup | undefined {
  return captures.getStore()?.fullBackups?.get(realpathSync.native(sourcePath));
}

export function getDoctorMigrationBackup(
  db: DatabaseSync,
  options: Parameters<DoctorMigrationBackup>[1],
) {
  const context = captures.getStore();
  if (context?.capture) {
    if (context.capture.expected(resolveUpdateSqlitePath(options.path)) !== undefined) {
      throw new Error("Updater migration requires its captured source generation.");
    }
    context.capture.refuse("The migration source path is outside the updater's captured paths.");
    // Relocation cannot certify the installed driver's old path keys. A fresh Doctor
    // backup may still preserve this source without becoming that updater's baseline.
    return captures.run({ ...context, capture: undefined, source: undefined }, () =>
      context.backup?.(db, options),
    );
  }
  return context?.backup?.(db, options);
}

function migrationAuthority(
  capture: UpdateDoctorMigrationCapture,
  pathname: string,
  assertMigrationCurrent?: () => void,
) {
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (!maintenance?.ownsSchemaMaintenance) {
    capture.refuse("Migration did not retain schema maintenance custody.");
    throw new Error("Database migration requires schema maintenance custody.");
  }
  return () => {
    maintenance.assertAdmission();
    if (assertMigrationCurrent) {
      assertMigrationCurrent();
    } else {
      assertStateDatabaseAccessAllowed(pathname);
    }
    capture.assertCurrent();
  };
}

function readSqliteGeneration(pathname: string): string | null {
  const value: unknown = JSON.parse(
    runSqliteReadOnlyWorkerSync(pathname, undefined, "update-generation"),
  );
  if (value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))) {
    throw new Error("Database generation child returned an invalid generation.");
  }
  return value;
}

function readSqliteFiles(pathname: string) {
  return parseSqliteFileGeneration(
    runSqliteReadOnlyWorkerSync(pathname, undefined, "file-generation"),
  );
}

/** A source proof exists only within its verified migration's lexical interval. */
export function getUpdateDoctorMigrationSource(pathname: string) {
  const context = captures.getStore();
  const key = resolveUpdateSqlitePath(pathname);
  const source =
    context?.source?.path === key
      ? context.source
      : context?.companions?.find((entry) => entry.path === key);
  if (!source) {
    return undefined;
  }
  const { generation, assertCurrent } = source;
  assertCurrent();
  return { path: pathname, generation, assertCurrent };
}

export function hasUpdateDoctorMigrationCapture(): boolean {
  return captures.getStore()?.capture !== undefined;
}

type SqliteMigrationOptions = {
  retainExclusive?: boolean;
  created?: boolean;
  /** Already-open companion custody stays held through this synchronous native phase. */
  companions?: readonly { database: DatabaseSync; path: string; created?: boolean }[];
};

type MigrationObservationStep = {
  read(): void;
  readAsync(signal?: AbortSignal): Promise<void>;
};

/** Retain the source's native exclusion across its commits and isolated postimage read. */
export function runUpdateSqliteMigration<T>(
  ...args: Parameters<typeof updateSqliteMigrationSteps<T>>
): T {
  const operation = updateSqliteMigrationSteps(...args);
  let step = operation.next();
  while (!step.done) {
    try {
      step.value.read();
      step = operation.next();
    } catch (error) {
      step = operation.throw(error);
    }
  }
  return step.value;
}

/** Await observations outside transactions while the native migration owner stays held. */
export async function runUpdateSqliteMigrationAsync<T>(
  ...args: Parameters<typeof updateSqliteMigrationSteps<T>>
): Promise<T> {
  const signal = resolveSqliteInspectionSignal(getAsyncWorkSignal());
  signal?.throwIfAborted();
  const operation = updateSqliteMigrationSteps(...args);
  let step = operation.next();
  while (!step.done) {
    try {
      await step.value.readAsync(signal);
      signal?.throwIfAborted();
      step = operation.next();
    } catch (error) {
      step = operation.throw(error);
    }
  }
  if (isPromiseLike(step.value)) {
    throw new Error("Update migration callbacks must remain synchronous.");
  }
  return step.value;
}

function* updateSqliteMigrationSteps<T>(
  db: DatabaseSync,
  pathname: string,
  operation: () => T,
  options?: SqliteMigrationOptions,
): Generator<MigrationObservationStep, T, void> {
  const context = captures.getStore();
  if (!context?.capture) {
    return operation();
  }
  const key = resolveUpdateSqlitePath(pathname);
  const inherited = getUpdateDoctorMigrationSource(pathname);
  if (inherited) {
    inherited.assertCurrent();
    const [companion, ...remaining] = options?.companions ?? [];
    return companion
      ? yield* updateSqliteMigrationSteps(companion.database, companion.path, operation, {
          created: companion.created,
          retainExclusive: true,
          companions: remaining,
        })
      : operation();
  }
  const { capture } = context;
  const expected = capture.expected(key);
  const opened = capture.openedSqlitePaths?.has(key);
  if (typeof expected !== "string" && !(expected === null && options?.created)) {
    return operation();
  }
  const assertCurrent = migrationAuthority(capture, pathname);
  assertCurrent();
  if (db.isTransaction) {
    throw new Error("Update migration exclusion must precede the source transaction.");
  }
  const mode = db.prepare("PRAGMA locking_mode").get()?.locking_mode; // sqlite-allow-raw -- Preserve connection-local policy.
  let outcome: { value: T } | { error: unknown };
  try {
    try {
      // Maintenance owns the source; concurrent outside writers are unsupported.
      if (expected === null) {
        let files: ReturnType<typeof readSqliteFiles> | undefined;
        yield {
          read() {
            files = readSqliteFiles(pathname);
          },
          async readAsync(signal) {
            files = parseSqliteFileGeneration(
              await runSqliteReadOnlyWorker(pathname, { mode: "file-generation", signal }),
            );
          },
        };
        assertCurrent();
        if (!files || files.database.size !== 0n || files.journal || files.wal) {
          throw new Error("Created SQLite migration family is no longer empty.");
        }
      }
      // Empty-reader alternates preserve the shipped admission semantics. Native
      // descriptor closes belong to the isolated reader while this owner holds locks.
      let before: string | null | undefined = expected === null ? null : undefined;
      if (expected !== null) {
        yield {
          read() {
            before =
              opened || mode === "exclusive"
                ? readSqliteGeneration(pathname)
                : readMatchingUpdateDatabaseGeneration(pathname, expected);
          },
          async readAsync(signal) {
            const { readUpdateSqliteDatabaseGenerationPairIsolated } =
              await import("./update-candidate-state.inspection.js");
            const pair = await readUpdateSqliteDatabaseGenerationPairIsolated([pathname], {
              signal,
            });
            const observed = pair.committed[pathname];
            before =
              opened || mode === "exclusive"
                ? observed
                : observed === expected || pair.emptyReaderAlternates[pathname] === expected
                  ? (observed ?? undefined)
                  : undefined;
          },
        };
      }
      assertCurrent();
      if (before === undefined || (!opened && mode === "exclusive" && before !== expected)) {
        throw new Error(`SQLite migration source changed after update capture: ${pathname}`);
      }
      capture.openedSqlitePaths?.add(key);
      if (before !== expected) {
        capture.accept(key, expected, before);
      }
      if (mode !== "exclusive") {
        // Start WAL in normal mode before retaining exclusion so it can be released.
        db.prepare("PRAGMA schema_version").get(); // sqlite-allow-raw -- Attach native WAL coordination before retaining exclusion.
      }
      db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; ROLLBACK;"); // sqlite-allow-raw -- Bound the migration's native exclusion.
      assertCurrent();
      const source: MigrationSource | undefined =
        before === null ? undefined : { path: key, generation: before, assertCurrent };
      const migrationContext = {
        capture,
        source,
        companions: [...(context.companions ?? []), ...(context.source ? [context.source] : [])],
        assertMigrationCurrent: assertCurrent,
      };
      let value: T;
      const [companion, ...remaining] = options?.companions ?? [];
      if (companion) {
        const native = updateSqliteMigrationSteps(companion.database, companion.path, operation, {
          created: companion.created,
          retainExclusive: true,
          companions: remaining,
        });
        const resume = (failure?: { error: unknown }) =>
          captures.run(migrationContext, () =>
            failure ? native.throw(failure.error) : native.next(),
          );
        let step = resume();
        while (!step.done) {
          try {
            yield step.value;
            step = resume();
          } catch (error) {
            step = resume({ error });
          }
        }
        value = step.value;
      } else {
        value = captures.run(migrationContext, operation);
      }
      if (isPromiseLike(value)) {
        throw new Error("Update migration callbacks must remain synchronous.");
      }
      if (db.isTransaction) {
        throw new Error("Update migration publication requires its committed native owner.");
      }
      assertCurrent();
      truncateSqliteWal(db, pathname);
      let after: string | null | undefined;
      yield {
        read() {
          after = readSqliteGeneration(pathname);
        },
        async readAsync(signal) {
          const { readUpdateSqliteDatabaseGenerationPairIsolated } =
            await import("./update-candidate-state.inspection.js");
          const pair = await readUpdateSqliteDatabaseGenerationPairIsolated([pathname], { signal });
          after = pair.committed[pathname];
        },
      };
      assertCurrent();
      if (after === undefined) {
        throw new Error("Database generation child returned an invalid generation.");
      }
      capture.accept(key, before, after);
      outcome = { value };
    } catch (error) {
      capture.refuse(
        `SQLite migration publication could not be verified: ${formatErrorMessage(error)}`,
      );
      throw error;
    }
  } catch (error) {
    outcome = { error };
  }
  try {
    try {
      if (db.isOpen && mode !== "exclusive" && !options?.retainExclusive) {
        if (db.isTransaction) {
          throw new Error("Update migration left its source transaction open.");
        }
        db.exec("PRAGMA locking_mode=NORMAL; PRAGMA page_count;"); // sqlite-allow-raw -- Release only our connection-local exclusion.
      }
    } catch (error) {
      capture.refuse("SQLite migration native custody could not be released.");
      throw error;
    }
  } catch (releaseError) {
    if ("error" in outcome) {
      throw createSqliteLifecycleAggregateError(
        [outcome.error, releaseError],
        "Update migration exclusion and resource release both failed",
        outcome.error,
      );
    }
    throw new SqliteCoordinatorError(
      "Update migration exclusion completed, but releasing its resource failed",
      releaseError,
    );
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

/** Unknown companions remain outside an older driver's inventory. Their caller retains custody. */
export function beginUpdateSqliteCompanion(db: DatabaseSync, pathname: string, created: boolean) {
  const context = captures.getStore();
  const capture = context?.capture;
  if (!capture) {
    return undefined;
  }
  const key = resolveUpdateSqlitePath(pathname);
  const expected = capture.expected(key);
  if (expected === undefined) {
    return undefined;
  }
  const assertCurrent = context?.assertMigrationCurrent;
  if (!assertCurrent) {
    capture.refuse("Migration companion has no verified source custody.");
    throw new Error("Migration companion requires verified source custody.");
  }
  assertCurrent();
  const mode = db.prepare("PRAGMA locking_mode").get()?.locking_mode; // sqlite-allow-raw -- The caller retains native exclusion through publication.
  if (mode !== "exclusive") {
    throw new Error("Migration companion requires its exclusive native owner.");
  }
  const before = created && expected === null ? null : readSqliteGeneration(pathname);
  assertCurrent();
  // Session settlement owns the final postimage of paths this Doctor already opened.
  if (!capture.openedSqlitePaths?.has(key) && before !== expected) {
    capture.refuse("Migration companion changed after update capture.");
    throw new Error("Database migration companion no longer matches its capture.");
  }
  capture.openedSqlitePaths?.add(key);
  return {
    complete() {
      assertCurrent();
      if (!db.isOpen || db.isTransaction) {
        throw new Error("Migration companion publication requires its committed native owner.");
      }
      const after = readSqliteGeneration(pathname);
      assertCurrent();
      capture.accept(key, before, after);
    },
  };
}

/** Called inside the engine's migration transaction, before its first mutation. */
export function beginUpdatePostgresMigration(
  db: PostgresSyncConnection,
  assertMigrationCurrent?: () => void,
) {
  const context = captures.getStore();
  const capture = context?.capture;
  const pathname = db.anchor.location();
  const expected = pathname && capture?.expected(pathname);
  if (!capture || !pathname || typeof expected !== "string") {
    return undefined;
  }
  if (!getOpenClawDatabaseMaintenanceScope()?.ownsSchemaMaintenance) {
    capture.refuse("PostgreSQL migration did not retain schema maintenance custody.");
    return undefined;
  }
  const assertCurrent = migrationAuthority(capture, pathname, assertMigrationCurrent);
  assertCurrent();
  // The bridge locks tables and sequences before reading, excluding ordinary SQL writers too.
  const before = db.readRecoveryGeneration(true);
  if (before !== expected) {
    capture.refuse("PostgreSQL changed before migration acquired native custody.");
    throw new Error("PostgreSQL migration source changed after update capture.");
  }
  const source = {
    path: pathname,
    generation: before,
    assertCurrent,
  };
  let publish: (() => void) | undefined;
  return {
    run<T>(operation: () => T): T {
      return captures.run({ capture, source, assertMigrationCurrent: assertCurrent }, operation);
    },
    beforeCommit() {
      assertCurrent();
      const after = db.readRecoveryGeneration(false);
      publish = () => capture.accept(pathname, before, after);
      assertCurrent();
    },
    committed() {
      assertCurrent();
      // The postimage was read under the transaction's native locks. A later writer
      // is detected by the maintenance interval's existing final generation check.
      publish?.();
    },
  };
}
