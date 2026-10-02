import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import { requireDirectorySync, syncDirectorySync } from "./directory-durability.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import {
  assertPackageActivationLayout,
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-paths.js";
import {
  withExistingSqliteRollbackDatabase,
  type ExistingSqliteTransaction,
} from "./sqlite-existing-database.js";
import type { SqliteReadOnlyOperationContext } from "./sqlite-readonly-operation-types.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import {
  ImmutableInstallDescriptorSchema,
  ImmutableInstallRecordSchema,
  ImmutablePreparedGenerationSchema,
  type ImmutableInstallDescriptor,
  type ImmutableInstallRecord,
  type ImmutablePreparedGeneration,
} from "./update-immutable-install-schema.js";

const MAX_RECORD_BYTES = 64 * 1024;
type ImmutableRow = {
  slot: number;
  revision: number;
  descriptor_json: string;
  prepared_json: string;
};
const queries = (db: DatabaseSync) =>
  getNodeSqliteKysely<{ immutable_installation: ImmutableRow }>(db);

function rootOwnedIdentity(file: string, directory: boolean): string {
  const stat = fs.lstatSync(file, { bigint: true });
  if (
    stat.uid !== 0n ||
    stat.ino === 0n ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) ||
    (stat.mode & 0o022n) !== 0n ||
    fs.realpathSync(file) !== file
  ) {
    throw new Error(`Immutable installation control has unsafe ownership or permissions: ${file}`);
  }
  return `${stat.dev}:${stat.ino}`;
}

function validateRecord(record: ImmutableInstallRecord): ImmutableInstallRecord {
  const parsed = ImmutableInstallRecordSchema.parse(record);
  for (const generation of [parsed.descriptor.current, parsed.prepared]) {
    if (
      generation &&
      generation.path !== path.join(parsed.descriptor.root, "releases", generation.sha)
    ) {
      throw new Error("Immutable generation is outside its recorded release root.");
    }
  }
  if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_RECORD_BYTES) {
    throw new Error("Immutable installation record exceeds 64 KiB.");
  }
  return parsed;
}

function readRecord(db: DatabaseSync, root: string, rootIdentity: string): ImmutableInstallRecord {
  const rows = executeSqliteQuerySync(
    db,
    queries(db)
      .selectFrom("immutable_installation")
      .selectAll()
      .where(sql<boolean>`length(CAST(descriptor_json AS BLOB)) <= ${MAX_RECORD_BYTES}`)
      .where(sql<boolean>`length(CAST(prepared_json AS BLOB)) <= ${MAX_RECORD_BYTES}`)
      .limit(2),
  ).rows;
  const row = rows[0];
  if (rows.length !== 1 || !row || row.slot !== 1) {
    throw new Error("Immutable installation control must contain one bounded record.");
  }
  const record = validateRecord({
    revision: row.revision,
    descriptor: JSON.parse(row.descriptor_json),
    prepared: JSON.parse(row.prepared_json),
  });
  if (record.descriptor.root !== root || record.descriptor.rootIdentity !== rootIdentity) {
    throw new Error("Immutable installation control does not match the installation.");
  }
  return record;
}

function withImmutableControl<T>(
  root: string,
  write: boolean,
  operation: (
    db: DatabaseSync,
    transact: ExistingSqliteTransaction,
    read: () => ImmutableInstallRecord,
  ) => T,
): T {
  const anchor = resolvePackageActivationAnchor(root);
  assertPackageActivationLayout(anchor);
  const control = resolvePackageActivationControl(anchor);
  const journal = resolvePackageActivationJournalPath(anchor);
  const rootIdentity = rootOwnedIdentity(root, true);
  const identities = [root, path.dirname(root), control, journal].map((file, index) =>
    rootOwnedIdentity(file, index !== 3),
  );
  const assertIdentity = () => {
    if (
      [root, path.dirname(root), control, journal].some(
        (file, index) => rootOwnedIdentity(file, index !== 3) !== identities[index],
      )
    ) {
      throw new Error("Immutable installation control identity changed.");
    }
  };
  return withExistingSqliteRollbackDatabase(
    journal,
    {
      write,
      busyTimeoutMs: 0,
      assertIdentity,
      validate(db) {
        const packageTable = db // sqlite-allow-raw -- Admission rejects legacy package journals without migrating them.
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'package_activation'",
          )
          .get();
        if (packageTable) {
          throw new Error(
            "An existing package activation journal remains with its recovery owner.",
          );
        }
        executeSqliteQuerySync(
          db,
          queries(db).selectFrom("immutable_installation").selectAll().limit(0),
        );
      },
    },
    (db, transact) => {
      if (write) {
        db.exec("PRAGMA synchronous = EXTRA"); // sqlite-allow-raw -- Reuse activation's durable rollback-journal commit contract.
      }
      const fencedTransaction: ExistingSqliteTransaction = (work, options) =>
        transact(work, {
          ...options,
          withCommit(commit) {
            assertIdentity();
            if (options?.withCommit) {
              options.withCommit(commit);
            } else {
              commit();
            }
          },
        });
      return operation(db, fencedTransaction, () => readRecord(db, root, rootIdentity));
    },
  );
}

/** CLI adoption only; the caller retains live installation/executor authority. */
export function createImmutableInstallRecord(
  descriptor: ImmutableInstallDescriptor,
  assertCurrent: () => void,
): ImmutableInstallRecord {
  const record = validateRecord({
    revision: 0,
    descriptor: ImmutableInstallDescriptorSchema.parse(descriptor),
    prepared: null,
  });
  const root = record.descriptor.root;
  const anchor = resolvePackageActivationAnchor(root);
  const control = resolvePackageActivationControl(anchor);
  const parent = path.dirname(root);
  const parentIdentity = rootOwnedIdentity(parent, true);
  const assertAdoption = () => {
    assertCurrent();
    assertPackageActivationLayout(anchor);
    if (
      rootOwnedIdentity(root, true) !== record.descriptor.rootIdentity ||
      rootOwnedIdentity(parent, true) !== parentIdentity ||
      fs.lstatSync(control, { throwIfNoEntry: false })
    ) {
      throw new Error(
        "Immutable adoption requires an unchanged installation and no existing control.",
      );
    }
  };
  assertAdoption();
  const stagedControl = fs.mkdtempSync(`${control}.prepare-`);
  const stagedIdentity = rootOwnedIdentity(stagedControl, true);
  const journal = path.join(stagedControl, "operation.sqlite");
  try {
    fs.chmodSync(stagedControl, 0o755);
    const fd = fs.openSync(journal, "wx", 0o644);
    try {
      fs.fchmodSync(fd, 0o644);
      const journalIdentity = rootOwnedIdentity(journal, false);
      const assertCreated = () => {
        assertAdoption();
        if (
          rootOwnedIdentity(stagedControl, true) !== stagedIdentity ||
          rootOwnedIdentity(journal, false) !== journalIdentity
        ) {
          throw new Error("Immutable adoption staging identity changed.");
        }
      };
      const db = openNodeSqliteDatabase(resolveExistingSqliteFileUri(journal));
      try {
        db.exec("PRAGMA synchronous = EXTRA"); // sqlite-allow-raw -- Adoption must be durable before its control directory is published.
        runSqliteImmediateTransactionSync(
          db,
          () => {
            assertCreated();
            executeSqliteQuerySync(
              db,
              queries(db)
                .schema.createTable("immutable_installation")
                .addColumn("slot", "integer", (column) =>
                  column
                    .primaryKey()
                    .notNull()
                    .check(sql`slot = 1`),
                )
                .addColumn("revision", "integer", (column) => column.notNull())
                .addColumn("descriptor_json", "text", (column) => column.notNull())
                .addColumn("prepared_json", "text", (column) => column.notNull())
                .modifyEnd(sql`STRICT`),
            );
            executeSqliteQuerySync(
              db,
              queries(db)
                .insertInto("immutable_installation")
                .values({
                  slot: 1,
                  revision: 0,
                  descriptor_json: JSON.stringify(record.descriptor),
                  prepared_json: "null",
                }),
            );
            assertCreated();
          },
          {
            withCommit(commit) {
              assertCreated();
              commit();
            },
          },
        );
      } finally {
        db.close();
      }
      fs.fsyncSync(fd);
      assertCreated();
    } finally {
      fs.closeSync(fd);
    }
    requireDirectorySync(syncDirectorySync(stagedControl), "Immutable adoption control");
    assertAdoption();
    fs.renameSync(stagedControl, control);
    requireDirectorySync(syncDirectorySync(parent), "Immutable adoption publication");
    return record;
  } finally {
    if (fs.lstatSync(stagedControl, { throwIfNoEntry: false })) {
      if (rootOwnedIdentity(stagedControl, true) === stagedIdentity) {
        fs.rmSync(stagedControl, { recursive: true });
      }
    }
  }
}

/** Recording preparation never grants pointer publication or service authority. */
export function recordImmutablePreparedGeneration(
  expected: ImmutableInstallRecord,
  prepared: ImmutablePreparedGeneration,
  assertCurrent: () => void,
): ImmutableInstallRecord {
  const next = validateRecord({
    ...expected,
    revision: expected.revision + 1,
    prepared: ImmutablePreparedGenerationSchema.parse(prepared),
  });
  assertCurrent();
  return withImmutableControl(expected.descriptor.root, true, (db, transact, read) =>
    transact(
      () => {
        assertCurrent();
        if (!isDeepStrictEqual(read(), expected)) {
          throw new Error("Immutable preparation record is no longer current.");
        }
        executeSqliteQuerySync(
          db,
          queries(db)
            .updateTable("immutable_installation")
            .set({
              revision: next.revision,
              prepared_json: JSON.stringify(next.prepared),
            })
            .where("slot", "=", 1)
            .where("revision", "=", expected.revision),
        );
        return read();
      },
      {
        withCommit(commit) {
          assertCurrent();
          commit();
        },
      },
    ),
  );
}

export const immutableInstallReadOperations = {
  "immutableInstall.read": (input: { root: string }, context: SqliteReadOnlyOperationContext) => {
    if (
      resolvePackageActivationJournalPath(resolvePackageActivationAnchor(input.root)) !==
      context.path
    ) {
      throw new Error("Immutable installation read names another control database.");
    }
    return withImmutableControl(input.root, false, (_db, _transact, read) => read());
  },
} satisfies WorkerOperationHandlers<SqliteReadOnlyOperationContext>;
