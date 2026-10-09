import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import { z } from "zod";
import { requireDirectorySync, syncDirectorySync } from "./directory-durability.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import {
  assertPackageActivationLayout,
  isPackageActivationComplete,
  packageActivationIdentity,
  privatePackageActivationIdentity as assertPrivate,
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
  resolvePackageActivationHelper,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-paths.js";
import {
  basename,
  packageActivationIdentitySchema,
  PackageActivationDescriptorSchema,
  PackageActivationPhaseSchema,
  intentSchema,
  type PackageActivationDescriptor,
  type PackageActivationPhase,
  type PackageActivationIntent,
  type PackageActivationRecord,
} from "./package-update-activation-schema.js";
import {
  withExistingSqliteRollbackDatabase,
  type ExistingSqliteTransaction,
} from "./sqlite-existing-database.js";
import { prepareSqliteRollbackRecovery } from "./sqlite-rollback-recovery.js";
export {
  assertPackageActivationLayout,
  isPackageActivationComplete,
  packageActivationIdentity,
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
  resolvePackageActivationHelper,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-paths.js";

export type {
  PackageActivationDescriptor,
  PackageActivationPhase,
  PackageActivationIntent,
  PackageActivationRecord,
} from "./package-update-activation-schema.js";
export { encodePackageActivationLauncher } from "./package-update-activation-launcher.js";
export { assertPackageActivationOperation } from "./package-update-activation-status.js";

const PACKAGE_ACTIVATION_JOURNAL = "operation.sqlite";
const MAX_PACKAGE_ACTIVATION_DESCRIPTOR_BYTES = 1024 * 1024;
type ActivationRow = {
  slot: number;
  revision: number;
  phase: string;
  descriptor_json: string;
  intent_json: string;
  publications_json: string;
};
const queries = (db: DatabaseSync) =>
  getNodeSqliteKysely<{ package_activation: ActivationRow }>(db);

function descriptorJson(descriptor: PackageActivationDescriptor): string {
  const encoded = JSON.stringify(PackageActivationDescriptorSchema.parse(descriptor));
  if (Buffer.byteLength(encoded) > MAX_PACKAGE_ACTIVATION_DESCRIPTOR_BYTES) {
    throw new Error("Package publication descriptor exceeds 1 MiB");
  }
  return encoded;
}

/** An existing operation is never bootstrapped, migrated, or repaired on open. */
export function openPackageActivationJournal(anchor: string) {
  assertPackageActivationLayout(anchor);
  const journalPath = resolvePackageActivationJournalPath(anchor);
  const parent = path.dirname(anchor);
  const parentIdentity = packageActivationIdentity(parent, "parent");
  const control = resolvePackageActivationControl(anchor);
  const journalParentIdentity = assertPrivate(control, "control");
  const journalIdentity = assertPrivate(journalPath, "journal");
  const assertFiles = () => {
    if (
      packageActivationIdentity(parent, "parent") !== parentIdentity ||
      assertPrivate(control, "control") !== journalParentIdentity ||
      assertPrivate(journalPath, "journal") !== journalIdentity ||
      fs.realpathSync(control) !== control
    ) {
      throw new Error("Package publication journal identity changed");
    }
  };
  const withDatabase = <T>(
    write: boolean,
    operation: (db: DatabaseSync, transact: ExistingSqliteTransaction) => T,
  ): T =>
    withExistingSqliteRollbackDatabase(
      journalPath,
      {
        write,
        busyTimeoutMs: 0,
        assertIdentity: assertFiles,
        validate: (db) => {
          executeSqliteQuerySync(
            db,
            queries(db).selectFrom("package_activation").selectAll().limit(0),
          );
        },
      },
      (db, transact) => {
        if (write) {
          // Persist rollback-journal deletion before the next filesystem effect.
          db.exec("PRAGMA synchronous = EXTRA"); // sqlite-allow-raw -- Durable package intent before rename.
        }
        return operation(db, transact);
      },
    );
  const matchesInstallation = (descriptor: PackageActivationDescriptor) =>
    descriptor.parentIdentity === parentIdentity &&
    descriptor.journalParentIdentity === journalParentIdentity &&
    descriptor.journalIdentity === journalIdentity;
  const decode = (
    row: ActivationRow | undefined,
    completedInstallKey?: string,
  ): PackageActivationRecord => {
    if (
      !row ||
      row.slot !== 1 ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0 ||
      Buffer.byteLength(row.descriptor_json) > MAX_PACKAGE_ACTIVATION_DESCRIPTOR_BYTES
    ) {
      throw new Error("Package publication journal is missing or invalid");
    }
    const descriptor = PackageActivationDescriptorSchema.parse(JSON.parse(row.descriptor_json));
    if (
      resolvePackageActivationAnchor(descriptor.authority.installKey) !== anchor ||
      packageActivationIdentity(parent, "parent") !== parentIdentity ||
      (completedInstallKey !== undefined &&
        descriptor.authority.installKey !== completedInstallKey) ||
      new Set(descriptor.launchers.map((entry) => entry.name)).size !== descriptor.launchers.length
    ) {
      throw new Error("Package publication journal does not match its installation");
    }
    const expectedTransfers = new Map<string, string>([
      ["anchor", descriptor.anchorIdentity],
      ["helper", descriptor.helperIdentity],
      ["candidate", descriptor.candidate.identity],
      ["launchers", descriptor.launcherRootIdentity],
    ]);
    if (descriptor.previousLauncherRootIdentity) {
      expectedTransfers.set("previous-launchers", descriptor.previousLauncherRootIdentity);
    }
    if (
      descriptor.preparation.length !== expectedTransfers.size ||
      new Set(descriptor.preparation.map((entry) => entry.name)).size !== expectedTransfers.size ||
      descriptor.preparation.some(
        (entry) => expectedTransfers.get(entry.name) !== entry.identity,
      ) ||
      descriptor.preparation.find((entry) => entry.name === "candidate")?.source !==
        descriptor.originalStageRoot
    ) {
      throw new Error("Preparation custody does not match the recorded objects.");
    }
    const publications = z
      .array(z.strictObject({ name: basename, identity: packageActivationIdentitySchema }))
      .max(64)
      .parse(JSON.parse(row.publications_json));
    const intent = intentSchema.parse(JSON.parse(row.intent_json));
    const names = new Set(descriptor.launchers.map((entry) => entry.name));
    if (
      new Set(publications.map((entry) => entry.name)).size !== publications.length ||
      publications.some((entry) => !names.has(entry.name)) ||
      (intent?.kind === "launcher" && !names.has(intent.name))
    ) {
      throw new Error("Package publication intent names an unknown launcher.");
    }
    const record = {
      revision: row.revision,
      phase: PackageActivationPhaseSchema.parse(row.phase),
      intent,
      descriptor,
      publications,
    };
    // Closed history conveys no authority over today's package, helper, or
    // lease store. Only unfinished recovery needs its original identities.
    if (!matchesInstallation(descriptor) && !isPackageActivationComplete(anchor, record)) {
      throw new Error("Package publication journal does not match its installation");
    }
    return record;
  };
  const readRow = (db: DatabaseSync) => {
    const sizes = executeSqliteQuerySync(
      db,
      queries(db)
        .selectFrom("package_activation")
        .select((eb) => [
          "slot",
          eb.fn<number>("length", [eb.cast("descriptor_json", "blob")]).as("descriptor_bytes"),
          eb.fn<number>("length", [eb.cast("intent_json", "blob")]).as("intent_bytes"),
          eb.fn<number>("length", [eb.cast("publications_json", "blob")]).as("publications_bytes"),
        ])
        .limit(2),
    ).rows;
    const size = sizes[0];
    if (
      sizes.length !== 1 ||
      !size ||
      size.slot !== 1 ||
      [size.descriptor_bytes, size.intent_bytes, size.publications_bytes].some(
        (bytes) => bytes > MAX_PACKAGE_ACTIVATION_DESCRIPTOR_BYTES,
      )
    ) {
      throw new Error("Package publication journal must contain one bounded operation.");
    }
    const rows = executeSqliteQuerySync(
      db,
      queries(db).selectFrom("package_activation").selectAll().limit(2),
    ).rows;
    if (rows.length !== 1) {
      throw new Error("Package publication journal must contain exactly one operation.");
    }
    return rows[0];
  };
  const read = () => withDatabase(false, (db) => decode(readRow(db)));
  const assertRecord = (expected: PackageActivationRecord, actual: PackageActivationRecord) => {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error("Package publication intent is no longer current");
    }
  };
  const transition = (
    expected: PackageActivationRecord,
    phase: PackageActivationPhase,
    intent: PackageActivationIntent,
    assertCurrent: () => void,
    publications = expected.publications,
    descriptor = expected.descriptor,
  ): PackageActivationRecord => {
    const descriptorJsonValue = descriptorJson(descriptor);
    const intentJson = JSON.stringify(intentSchema.parse(intent));
    PackageActivationPhaseSchema.parse(phase);
    assertCurrent();
    return withDatabase(true, (db, transact) =>
      transact(
        () => {
          assertFiles();
          assertCurrent();
          assertRecord(expected, decode(readRow(db)));
          executeSqliteQuerySync(
            db,
            queries(db)
              .updateTable("package_activation")
              .set({
                revision: expected.revision + 1,
                phase,
                descriptor_json: descriptorJsonValue,
                intent_json: intentJson,
                publications_json: JSON.stringify(publications),
              })
              .where("slot", "=", 1)
              .where("revision", "=", expected.revision),
          );
          return decode(readRow(db));
        },
        {
          withCommit: (commit) => {
            assertFiles();
            assertCurrent();
            commit();
          },
        },
      ),
    );
  };
  return {
    read,
    archiveSettled(expected: PackageActivationRecord, assertCurrent: () => void) {
      const retained = `${anchor}.superseded-${expected.descriptor.operationId}`;
      const archive = path.join(retained, "control");
      const assertClosed = () => {
        assertCurrent();
        assertFiles();
        assertRecord(expected, read());
        if (!isPackageActivationComplete(anchor, expected)) {
          throw new Error("Only completed package settlement evidence can be archived.");
        }
      };
      assertClosed();
      // Capture today's evidence solely for a fenced rename, never for deletion
      // or restoration. Historical inode/helper fingerprints no longer own it.
      const source = fs.lstatSync(anchor, { throwIfNoEntry: false });
      const destination = fs.lstatSync(retained, { throwIfNoEntry: false });
      if (source && destination) {
        throw new Error("Package settlement evidence archive already exists.");
      }
      let retainedIdentity: string;
      if (source) {
        retainedIdentity = packageActivationIdentity(anchor, true);
        assertClosed();
        try {
          fs.renameSync(anchor, retained);
        } catch (error) {
          if (
            fs.lstatSync(anchor, { throwIfNoEntry: false }) ||
            !fs.lstatSync(retained, { throwIfNoEntry: false }) ||
            packageActivationIdentity(retained, true) !== retainedIdentity
          ) {
            throw error;
          }
        }
      } else {
        if (!destination) {
          assertClosed();
          fs.mkdirSync(retained, { mode: 0o700 });
        }
        retainedIdentity = packageActivationIdentity(retained, true);
      }
      const assertSettled = () => {
        assertClosed();
        if (
          packageActivationIdentity(retained, true) !== retainedIdentity ||
          fs.realpathSync(retained) !== retained ||
          fs.lstatSync(archive, { throwIfNoEntry: false })
        ) {
          throw new Error("Package settlement control archive changed or already exists.");
        }
      };
      assertSettled();
      for (const directory of [control, parent, retained]) {
        requireDirectorySync(syncDirectorySync(directory), "Package settlement control archive");
      }
      assertSettled();
      // The durable settled receipt disarms recovery before the entire active
      // control path leaves admission. Preserve its inode and bytes for inspection;
      // old readers never need to decode a newer historical settlement reason.
      try {
        fs.renameSync(control, archive);
      } catch (error) {
        // A lost rename acknowledgement must still reach both directory syncs.
        // Only the exact moved control object, with no active source, can qualify.
        if (
          fs.lstatSync(control, { throwIfNoEntry: false }) ||
          !fs.lstatSync(archive, { throwIfNoEntry: false }) ||
          assertPrivate(archive, "control") !== journalParentIdentity
        ) {
          throw error;
        }
      }
      for (const directory of [retained, parent]) {
        assertCurrent();
        if (
          packageActivationIdentity(parent, "parent") !== parentIdentity ||
          fs.realpathSync(retained) !== retained ||
          packageActivationIdentity(retained, true) !== retainedIdentity ||
          assertPrivate(archive, "control") !== journalParentIdentity ||
          assertPrivate(path.join(archive, PACKAGE_ACTIVATION_JOURNAL), "journal") !==
            journalIdentity
        ) {
          throw new Error("Package settlement control archive identity changed.");
        }
        requireDirectorySync(syncDirectorySync(directory), "Package settlement control archive");
      }
      assertCurrent();
    },
    readForAdmission(installKey: string) {
      return withDatabase(false, (db) => decode(readRow(db), installKey));
    },
    recordPreviousCopy(
      expected: PackageActivationRecord,
      previous: PackageActivationDescriptor["previous"],
      assertCurrent: () => void,
    ) {
      if (
        expected.phase !== "publishing" ||
        expected.intent?.kind !== "copy-previous" ||
        expected.intent.identity !== previous.identity
      ) {
        throw new Error("Package copy does not match its recorded custody.");
      }
      return transition(
        expected,
        "publishing",
        {
          kind: "displace-copy",
          source: expected.descriptor.previous,
          removing: false,
        },
        assertCurrent,
        expected.publications,
        { ...expected.descriptor, previous },
      );
    },
    readForRecovery() {
      return prepareSqliteRollbackRecovery({
        path: journalPath,
        scratchRoot: control,
        assertIdentity: assertFiles,
        assertFileSafe(file) {
          assertPrivate(file, "rollback-journal");
        },
        read: (db) => decode(readRow(db)),
      });
    },
    replaceCompleted(
      expected: PackageActivationRecord,
      descriptor: Omit<PackageActivationDescriptor, "journalIdentity">,
      assertCurrent: () => void,
    ) {
      const encoded = descriptorJson({ ...descriptor, journalIdentity });
      return withDatabase(true, (db, transact) =>
        transact(
          () => {
            assertFiles();
            assertCurrent();
            const previous = decode(readRow(db));
            assertRecord(expected, previous);
            if (
              !isPackageActivationComplete(anchor, previous) ||
              fs.lstatSync(anchor, { throwIfNoEntry: false }) ||
              fs.lstatSync(resolvePackageActivationHelper(anchor), { throwIfNoEntry: false }) ||
              descriptor.journalParentIdentity !== journalParentIdentity ||
              packageActivationIdentity(preparationSource(descriptor, "anchor"), true) !==
                descriptor.anchorIdentity ||
              packageActivationIdentity(preparationSource(descriptor, "helper"), false) !==
                descriptor.helperIdentity
            ) {
              throw new Error("The previous package receipt is not safely replaceable.");
            }
            executeSqliteQuerySync(
              db,
              queries(db)
                .updateTable("package_activation")
                .set({
                  revision: previous.revision + 1,
                  phase: "preparing",
                  descriptor_json: encoded,
                  intent_json: JSON.stringify({ kind: "prepare", completed: [], moving: null }),
                  publications_json: "[]",
                })
                .where("slot", "=", 1)
                .where("revision", "=", previous.revision),
            );
          },
          {
            withCommit: (commit) => {
              assertFiles();
              assertCurrent();
              commit();
            },
          },
        ),
      );
    },
    assertCurrent(expected: PackageActivationRecord) {
      assertRecord(expected, read());
    },
    transition(
      expected: PackageActivationRecord,
      phase: PackageActivationPhase,
      intent: PackageActivationIntent,
      assertCurrent: () => void,
      publications = expected.publications,
    ) {
      return transition(expected, phase, intent, assertCurrent, publications);
    },
  };
}
export type PackageActivationJournal = ReturnType<typeof openPackageActivationJournal>;

function preparationSource(
  descriptor: Omit<PackageActivationDescriptor, "journalIdentity">,
  name: "anchor" | "helper",
): string {
  const source = descriptor.preparation.find((entry) => entry.name === name)?.source;
  if (!source) {
    throw new Error("Package preparation bootstrap custody is missing.");
  }
  return source;
}

/** Only the original admitted producer may create the one-operation database. */
export function createPackageActivationJournal(
  anchor: string,
  descriptor: Omit<PackageActivationDescriptor, "journalIdentity">,
  stagedControl: string,
  assertCurrent: () => void,
  onCustody?: (retained: boolean) => void,
): PackageActivationJournal {
  const control = resolvePackageActivationControl(anchor);
  const journalPath = path.join(stagedControl, PACKAGE_ACTIVATION_JOURNAL);
  const helperPath = path.join(stagedControl, "recovery.mjs");
  const assertAnchor = () => {
    assertCurrent();
    assertPackageActivationLayout(anchor);
    if (
      assertPrivate(preparationSource(descriptor, "anchor"), "anchor") !==
        descriptor.anchorIdentity ||
      packageActivationIdentity(path.dirname(anchor), "parent") !== descriptor.parentIdentity ||
      fs.realpathSync(path.dirname(anchor)) !== path.dirname(anchor) ||
      assertPrivate(stagedControl, "control") !== descriptor.journalParentIdentity ||
      fs.realpathSync(stagedControl) !== stagedControl ||
      descriptor.journalParentIdentity.split(":")[0] !== descriptor.parentIdentity.split(":")[0] ||
      preparationSource(descriptor, "helper") !== resolvePackageActivationHelper(anchor) ||
      descriptor.preparation.find((entry) => entry.name === "helper")?.sourceParentIdentity !==
        descriptor.journalParentIdentity ||
      assertPrivate(helperPath, "helper") !== descriptor.helperIdentity ||
      createHash("sha256").update(fs.readFileSync(helperPath)).digest("hex") !==
        descriptor.helperDigest ||
      packageActivationIdentity(descriptor.authority.installKey, true) !==
        descriptor.previous.identity ||
      packageActivationIdentity(descriptor.originalStageRoot, true) !==
        descriptor.candidate.identity ||
      fs.lstatSync(anchor, { throwIfNoEntry: false }) ||
      fs.lstatSync(control, { throwIfNoEntry: false })
    ) {
      throw new Error("Package publication journal identity changed");
    }
  };
  assertAnchor();
  descriptorJson({ ...descriptor, journalIdentity: "0:0" });
  let journalIdentity: string;
  let initial: ActivationRow;
  const assertCreated = () => {
    assertAnchor();
    if (assertPrivate(journalPath, "journal") !== journalIdentity) {
      throw new Error("Package publication journal identity changed");
    }
  };
  const fd = fs.openSync(journalPath, "wx", 0o600);
  try {
    const created = fs.fstatSync(fd, { bigint: true });
    journalIdentity = `${created.dev}:${created.ino}`;
    initial = {
      slot: 1,
      revision: 0,
      phase: "preparing",
      descriptor_json: descriptorJson({ ...descriptor, journalIdentity }),
      intent_json: JSON.stringify({ kind: "prepare", completed: ["helper"], moving: null }),
      publications_json: "[]",
    };
    // Retain the created inode until SQLite closes; a later pathname must not
    // become the authority for the file this producer created.
    assertCreated();
    const db = openNodeSqliteDatabase(resolveExistingSqliteFileUri(journalPath));
    try {
      assertCreated();
      executeSqliteQuerySync(
        db,
        queries(db)
          .schema.createTable("package_activation")
          .addColumn("slot", "integer", (column) => column.primaryKey().notNull())
          .addColumn("revision", "integer", (column) => column.notNull())
          .addColumn("phase", "text", (column) => column.notNull())
          .addColumn("descriptor_json", "text", (column) => column.notNull())
          .addColumn("intent_json", "text", (column) => column.notNull())
          .addColumn("publications_json", "text", (column) => column.notNull())
          .modifyEnd(sql`STRICT`),
      );
      assertCreated();
      executeSqliteQuerySync(db, queries(db).insertInto("package_activation").values(initial));
    } finally {
      if (db.isOpen) {
        db.close();
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  const assertReady = () => {
    assertCreated();
    if (
      !isDeepStrictEqual(fs.readdirSync(stagedControl).toSorted(), [
        PACKAGE_ACTIVATION_JOURNAL,
        "recovery.mjs",
      ])
    ) {
      throw new Error("Private package control contains unknown objects.");
    }
  };
  const verifyPrivate = () =>
    withExistingSqliteRollbackDatabase(
      journalPath,
      { write: false, busyTimeoutMs: 0, assertIdentity: assertReady, validate: () => {} },
      (db) => {
        const rows = executeSqliteQuerySync(
          db,
          queries(db).selectFrom("package_activation").selectAll().limit(2),
        ).rows;
        if (rows.length !== 1 || !isDeepStrictEqual({ ...rows[0] }, initial)) {
          throw new Error("Private package publication journal is incomplete.");
        }
      },
    );
  verifyPrivate();
  requireDirectorySync(syncDirectorySync(stagedControl), "Private package control");
  // No public name exists until both closed objects are complete. A lost rename
  // acknowledgement retains stage custody; only proven nonpublication releases it.
  onCustody?.(true);
  try {
    assertReady();
    fs.renameSync(stagedControl, control);
    for (const directory of new Set([path.dirname(stagedControl), path.dirname(control)])) {
      assertCurrent();
      requireDirectorySync(syncDirectorySync(directory), "Package control publication");
    }
  } catch (error) {
    try {
      if (!fs.lstatSync(control, { throwIfNoEntry: false })) {
        verifyPrivate();
        onCustody?.(false);
      }
    } catch {
      // Unknown evidence is never permission for stage cleanup.
    }
    throw error;
  }
  const journal = openPackageActivationJournal(anchor);
  const published = journal.read();
  if (descriptorJson(published.descriptor) !== initial.descriptor_json) {
    throw new Error("Published package control identity changed.");
  }
  assertCurrent();
  return journal;
}
