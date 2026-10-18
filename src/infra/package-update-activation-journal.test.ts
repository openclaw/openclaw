import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHotSqliteRollbackJournal } from "../../test/helpers/sqlite-hot-journal.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as nodeSqlite from "./node-sqlite.js";
import { withDatabase } from "./package-update-activation-fixtures.test-support.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationJournalPath,
  type PackageActivationIntent,
  type PackageActivationPhase,
  type PackageActivationRecord,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import {
  readPackageActivationStatus,
  runPackageActivationRecovery,
} from "./package-update-activation.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const openDatabase = nodeSqlite.openNodeSqliteDatabase;
let root: string;
let assertDatabasePath: (path: string) => void;
let childGuardEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;

const lifetimeFixture = createPackageActivationLifetimeFixture();
beforeEach(() => {
  ({ root, assertDatabasePath, childGuardEnv } = lifetimeFixture.setup());
});
afterEach(async () => {
  try {
    await lifetimeFixture.lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

it("refuses foreign or aliased handoff and state paths before opening any store", () => {
  for (const livePath of [
    "/tmp/openclaw/managed-update-handoffs.sqlite",
    "/private/tmp/openclaw/managed-update-handoffs.sqlite",
  ]) {
    expect(() => assertDatabasePath(livePath)).toThrow();
  }
  const privatePath = path.join(root, "private-tmp", "managed-update-handoffs.sqlite");
  expect(() => assertDatabasePath(privatePath)).not.toThrow();
  const env = childGuardEnv(process.env);
  // Use another owned fixture as the refusal target; a broken guard must never
  // open the developer's live state store while proving this boundary.
  const foreignDirectory = fs.realpathSync(dirs.make("package-activation-foreign-state-"));
  const foreignState = path.join(foreignDirectory, "openclaw-state.sqlite");
  const alias = path.join(root, "foreign-state");
  fs.symlinkSync(foreignDirectory, alias, "junction");
  const danglingTarget = path.join(foreignDirectory, "dangling-state.sqlite");
  const danglingAlias = path.join(root, "dangling-state.sqlite");
  // Windows directory aliases use unprivileged junctions. A dangling file
  // symlink needs extra OS privilege, so exercise that POSIX-specific cut here.
  if (process.platform !== "win32") {
    fs.symlinkSync(danglingTarget, danglingAlias, "file");
  }
  const foreignNested = path.join(foreignDirectory, "nested");
  fs.mkdirSync(foreignNested);
  const nestedAlias = path.join(root, "foreign-nested");
  fs.symlinkSync(foreignNested, nestedAlias, "junction");
  // Do not use path.join: it would erase the traversal this case must exercise.
  const traversedState = `${nestedAlias}${path.sep}..${path.sep}traversed-state.sqlite`;
  const refusedPaths = [
    "/tmp/openclaw/managed-update-handoffs.sqlite",
    "/private/tmp/openclaw/managed-update-handoffs.sqlite",
    foreignState,
    path.join(alias, "openclaw-state.sqlite"),
    ...(process.platform !== "win32" ? [danglingAlias] : []),
    traversedState,
    `file:${traversedState}`,
    `file:${traversedState.replace(`${path.sep}..${path.sep}`, `${path.sep}%2e%2e${path.sep}`)}`,
  ];
  const requireGuard = `require('node:assert/strict').equal(globalThis[Symbol.for('openclaw.test.privateHandoffGuard')], ${JSON.stringify(privatePath)});`;
  const probe = (file: string, close = false) =>
    spawnSync(
      process.execPath,
      [
        "-e",
        `${requireGuard}new (require('node:sqlite').DatabaseSync)(${JSON.stringify(file)})${close ? ".close()" : ""}`,
      ],
      { env, encoding: "utf8" },
    );
  // The guard assertion runs before each attempt to open an untrusted path.
  const blockedResults = refusedPaths.map((file) => probe(file));
  for (const blocked of blockedResults) {
    expect(blocked.error).toBeUndefined();
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("ERR_ASSERTION");
  }
  for (const foreignPath of [
    foreignState,
    danglingTarget,
    path.join(foreignDirectory, "traversed-state.sqlite"),
  ]) {
    expect(fs.existsSync(foreignPath)).toBe(false);
  }
  for (const privateDatabase of [privatePath, path.join(root, "openclaw-state.sqlite")]) {
    const accepted = probe(privateDatabase, true);
    expect(accepted.error).toBeUndefined();
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(fs.realpathSync(privateDatabase)).toBe(privateDatabase);
    for (const uri of [
      nodeSqlite.resolveExistingSqliteFileUri(privateDatabase),
      nodeSqlite.resolveImmutableSqliteFileUri(privateDatabase),
    ]) {
      const reopened = probe(uri, true);
      expect(reopened.error).toBeUndefined();
      expect(reopened.status, reopened.stderr).toBe(0);
    }
  }
});

async function fixture() {
  const f = await lifetimeFixture.prepare();
  const journal = openPackageActivationJournal(f.anchor);
  const record = journal.read();
  const authority = record.descriptor.authority;
  const transition = (
    previous: PackageActivationRecord,
    phase: PackageActivationPhase,
    intent: PackageActivationIntent,
  ) =>
    withUpdateCommandExecutor(
      randomUUID(),
      async (executor) =>
        journal.transition(
          previous,
          phase,
          intent,
          (await executor.enter(f.packageRoot)).assertCurrent,
        ),
      { existingAuthority: authority },
    );
  return {
    ...f,
    journal,
    record,
    authority,
    transition,
    journalPath: resolvePackageActivationJournalPath(f.anchor),
  };
}

const journalFiles = lifetimeFixture.snapshotControl;

function replaceField(
  journalPath: string,
  column: "descriptor_json" | "revision" | "phase" | "intent_json" | "publications_json",
  value: string | number,
) {
  withDatabase(journalPath, (db) =>
    db.prepare(`UPDATE package_activation SET ${column} = ? WHERE slot = 1`).run(value),
  );
}

function createHotJournal(journalPath: string) {
  createHotSqliteRollbackJournal({
    path: journalPath,
    mutationSql: "UPDATE package_activation SET phase = 'publication-complete'",
    env: childGuardEnv({}),
  });
}

describe.skipIf(process.platform === "win32")("package activation journal", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });
  it("keeps unsafe journal link details local and reports the code without changing recovery evidence", async () => {
    const file = f.journalPath;
    fs.linkSync(file, path.join(root, "retained-journal.sqlite"));
    const before = journalFiles(f.anchor);
    const observed = fs.lstatSync(file);
    let failure: unknown;
    try {
      openPackageActivationJournal(f.anchor);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const fact = createUpdateErrorFact("package-swap", failure);
    const expected = [
      "Package recovery journal",
      JSON.stringify(file),
      `mode=0${(observed.mode & 0o777).toString(8)}`,
      `nlink=${observed.nlink}`,
      `uid=${observed.uid}`,
      "expected nlink=1",
      "openclaw doctor --fix",
    ];
    const report = await prepareUpdateFailureReport(
      {
        attemptId: "recovery-permissions",
        result: {
          mode: "npm",
          status: "error",
          durationMs: 1,
          steps: [
            {
              name: "package-swap",
              command: "",
              cwd: "",
              durationMs: 1,
              exitCode: 1,
              failureFacts: [fact],
            },
          ],
        },
      },
      { env: {}, stateDir: root },
    );
    for (const text of expected) {
      expect(failure).toMatchObject({ message: expect.stringContaining(text) });
    }
    expect(report.body).toContain(
      "Failing check package-swap (package-recovery-permissions-unsafe)",
    );
    expect(report.body).not.toContain(fact.message);
    expect(fact.message!.length).toBeLessThanOrEqual(200);
    expect(report.body).not.toContain(root);
    expect(journalFiles(f.anchor)).toEqual(before);
    expect(fs.lstatSync(file).nlink).toBe(observed.nlink);
    expect(fs.lstatSync(file).mode).toBe(observed.mode);
  });

  it.each([false, true])(
    "preserves a hot journal until recovery admission (replaced=%s)",
    async (replaced) => {
      createHotJournal(f.journalPath);
      const rollbackPath = `${f.journalPath}-journal`;
      expect(fs.statSync(rollbackPath).size).toBeGreaterThan(512);
      const before = journalFiles(f.anchor);
      withDatabase(
        f.journalPath,
        (db) => {
          expect(() => db.prepare("SELECT phase FROM package_activation").get()).toThrow(
            expect.objectContaining({ errcode: 776 }),
          );
        },
        true,
      );
      await expect(readPackageActivationStatus(f.anchor, f.operationId)).rejects.toThrow();
      expect(journalFiles(f.anchor)).toEqual(before);
      expect(fs.existsSync(`${f.journalPath}-wal`)).toBe(false);
      expect(fs.existsSync(`${f.journalPath}-shm`)).toBe(false);

      const admission = await f.journal.readForRecovery();
      expect(admission.record).toEqual(f.record);
      expect(journalFiles(f.anchor)).toEqual(before);
      await expect(runPackageActivationRecovery(f.anchor, "repair", randomUUID())).rejects.toThrow(
        "different operation",
      );
      expect(journalFiles(f.anchor)).toEqual(before);
      const rollback = fs.readFileSync(rollbackPath);
      if (replaced) {
        const replacement = path.join(path.dirname(f.journalPath), "replacement.sqlite");
        fs.copyFileSync(f.journalPath, replacement);
        fs.renameSync(replacement, f.journalPath);
      }
      await withUpdateCommandExecutor(
        randomUUID(),
        async (executor) => {
          const fence = await executor.enter(f.packageRoot);
          if (replaced) {
            expect(() => admission.admit(fence.assertCurrent)).toThrow("changed");
          } else {
            admission.admit(fence.assertCurrent);
          }
        },
        { existingAuthority: f.authority },
      );
      if (replaced) {
        expect(fs.readFileSync(rollbackPath)).toEqual(rollback);
      } else {
        expect(f.journal.read()).toEqual(f.record);
        expect(fs.existsSync(rollbackPath)).toBe(false);
      }
    },
  );

  it.each([false, true])(
    "status refuses foreign WAL without touching its files (liveWriter=%s)",
    async (liveWriter) => {
      const database = new DatabaseSync(f.journalPath);
      try {
        database.exec("PRAGMA journal_mode = WAL");
        if (liveWriter) {
          database.exec("UPDATE package_activation SET revision = revision + 1; BEGIN IMMEDIATE");
          expect(fs.statSync(`${f.journalPath}-wal`).size).toBeGreaterThan(0);
        } else {
          database.close();
        }
        expect(fs.readFileSync(f.journalPath)[18]).toBe(2);
        expect(fs.existsSync(`${f.journalPath}-wal`)).toBe(liveWriter);
        expect(fs.existsSync(`${f.journalPath}-shm`)).toBe(liveWriter);
        const before = journalFiles(f.anchor);
        await expect(readPackageActivationStatus(f.anchor, f.operationId)).rejects.toThrow();
        expect(journalFiles(f.anchor)).toEqual(before);
        await expect(
          runPackageActivationRecovery(f.anchor, "repair", f.operationId),
        ).rejects.toThrow();
        expect(journalFiles(f.anchor)).toEqual(before);
      } finally {
        if (database.isOpen) {
          database.close();
        }
      }
    },
  );

  it("keeps all 64 bounded launcher entries while exact-revision intents advance", async () => {
    const launchers = Array.from({ length: 64 }, (_, index) => ({
      ...f.record.descriptor.launchers[0]!,
      name: `launcher-${index}`,
      previous: "p".repeat(4096),
      candidate: "c".repeat(4096),
    }));
    replaceField(
      f.journalPath,
      "descriptor_json",
      JSON.stringify({ ...f.record.descriptor, launchers }),
    );
    const record = openPackageActivationJournal(f.anchor).read();
    expect(record.descriptor.launchers).toEqual(launchers);
    expect(record).toMatchObject({ revision: f.record.revision, phase: "prepared", intent: null });
    const publishing = await f.transition(record, "publishing", { kind: "displace" });
    expect(publishing).toMatchObject({
      revision: f.record.revision + 1,
      phase: "publishing",
      intent: { kind: "displace" },
      descriptor: record.descriptor,
    });
    await expect(f.transition(record, "publication-complete", null)).rejects.toThrow(
      "no longer current",
    );
    expect(f.journal.read()).toEqual(publishing);
    const disarmed = await f.transition(publishing, "rollback-in-progress", null);
    const restored = await f.transition(disarmed, "rolled-back", null);
    expect(openPackageActivationJournal(f.anchor).read()).toEqual(restored);
    expect(restored).toMatchObject({
      revision: f.record.revision + 3,
      phase: "rolled-back",
      descriptor: record.descriptor,
    });
    withDatabase(
      f.journalPath,
      (db) => {
        expect(db.prepare("SELECT COUNT(*) AS count FROM package_activation").get()).toEqual({
          count: 1,
        });
      },
      true,
    );
  });

  it.each([
    { name: "malformed descriptor", column: "descriptor_json", value: () => "{" },
    { name: "unknown phase", column: "phase", value: () => "automatically-repaired" },
    { name: "negative revision", column: "revision", value: () => -1 },
    {
      name: "invalid intent",
      column: "intent_json",
      value: () => JSON.stringify({ kind: "displace", unexpected: true }),
    },
    {
      name: "invalid publication identity",
      column: "publications_json",
      value: () => JSON.stringify([{ name: "openclaw", identity: "not-an-inode" }]),
    },
    {
      name: "too many launchers",
      column: "descriptor_json",
      value: (record: PackageActivationRecord) =>
        JSON.stringify({
          ...record.descriptor,
          launchers: Array.from({ length: 65 }, (_, index) => ({
            name: `launcher-${index}`,
            previous: null,
            candidate: "candidate",
            previousIdentity: null,
            candidateIdentity: record.descriptor.launchers[0]!.candidateIdentity,
          })),
        }),
    },
    {
      name: "duplicate launcher names",
      column: "descriptor_json",
      value: (record: PackageActivationRecord) =>
        JSON.stringify({
          ...record.descriptor,
          launchers: [record.descriptor.launchers[0], record.descriptor.launchers[0]],
        }),
    },
    { name: "missing operation", column: null, value: () => "DELETE FROM package_activation" },
    {
      name: "additional operation",
      column: null,
      value: () =>
        "INSERT INTO package_activation SELECT 2, revision, phase, descriptor_json, intent_json, publications_json FROM package_activation WHERE slot = 1",
    },
  ] as const)("preserves a journal with $name", async ({ name, column, value }) => {
    if (column === null) {
      withDatabase(f.journalPath, (db) => db.exec(value()));
    } else {
      replaceField(f.journalPath, column, value(f.record));
    }
    const before = journalFiles(f.anchor);
    expect(() =>
      (column === null ? f.journal : openPackageActivationJournal(f.anchor)).read(),
    ).toThrow(name === "malformed descriptor" ? SyntaxError : undefined);
    await expect(f.transition(f.record, "publishing", { kind: "displace" })).rejects.toThrow();
    expect(journalFiles(f.anchor)).toEqual(before);
  });

  it.each(["rollback-in-progress", "retiring"] as const)(
    "refuses forward repair after %s is durable",
    async (phase) => {
      const disarmed = await f.transition(f.record, phase, null);
      const before = journalFiles(f.anchor);
      await expect(readPackageActivationStatus(f.anchor, f.operationId)).resolves.toEqual({
        phase,
        operationId: disarmed.descriptor.operationId,
        installKey: f.packageRoot,
      });
      await expect(runPackageActivationRecovery(f.anchor, "repair", f.operationId)).rejects.toThrow(
        `Forward publication is disarmed (${phase})`,
      );
      expect(journalFiles(f.anchor)).toEqual(before);
      expect(fs.existsSync(path.join(f.anchor, "candidate"))).toBe(true);
      expect(fs.readFileSync(f.launcher, "utf8")).toBe("old launcher\n");
      expect(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).toContain(
        '"version":"1.0.0"',
      );
    },
  );

  it("observes a committed intent after its acknowledgement is lost", async () => {
    const failure = new Error("journal commit acknowledgement lost");
    let lost = false;
    const spy = vi
      .spyOn(nodeSqlite, "openNodeSqliteDatabase")
      .mockImplementation((location, options) => {
        const db = openDatabase(location, options);
        if (db.location() === f.journalPath) {
          const exec = db.exec.bind(db);
          db.exec = (sql) => {
            exec(sql);
            if (!lost && sql === "COMMIT") {
              lost = true;
              throw failure;
            }
          };
        }
        return db;
      });
    try {
      await expect(f.transition(f.record, "publishing", { kind: "displace" })).rejects.toBe(
        failure,
      );
    } finally {
      spy.mockRestore();
    }
    expect(lost).toBe(true);
    const committed = openPackageActivationJournal(f.anchor).read();
    expect(committed).toMatchObject({
      revision: f.record.revision + 1,
      phase: "publishing",
      intent: { kind: "displace" },
      descriptor: f.record.descriptor,
    });
    expect(() => f.journal.assertCurrent(f.record)).toThrow("no longer current");
    const disarmed = await f.transition(committed, "rollback-in-progress", null);
    expect(disarmed.revision).toBe(f.record.revision + 2);
    expect(fs.existsSync(path.join(f.anchor, "candidate"))).toBe(true);
    expect(fs.readFileSync(f.launcher, "utf8")).toBe("old launcher\n");
  });

  it("preserves the current intent when its live executor refuses the write", async () => {
    const failure = new Error("executor authority revoked");
    const before = journalFiles(f.anchor);
    expect(() =>
      f.journal.transition(f.record, "publishing", { kind: "displace" }, () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(f.journal.read()).toEqual(f.record);
    expect(journalFiles(f.anchor)).toEqual(before);
  });
});

const jsonColumns = ["descriptor_json", "intent_json", "publications_json"] as const;

async function byteBoundsFixture(oversized: (typeof jsonColumns)[number]) {
  const { anchor, journalPath: file } = await fixture();
  replaceField(file, "descriptor_json", "{");
  // Under one million characters, but over the one MiB byte bound.
  replaceField(file, oversized, "é".repeat(512 * 1024 + 1));
  const snapshot = () => {
    const { dev, ino, mode, mtimeMs } = fs.statSync(file);
    return { names: fs.readdirSync(anchor), dev, ino, mode, mtimeMs, bytes: fs.readFileSync(file) };
  };
  return { anchor, snapshot };
}

describe.skipIf(process.platform === "win32")("existing package journal byte bounds", () => {
  it.each(jsonColumns)(
    "refuses oversized %s before decoding without modifying the original journal",
    async (column) => {
      const { anchor, snapshot } = await byteBoundsFixture(column);
      const before = snapshot();
      expect(() => openPackageActivationJournal(anchor).read()).toThrow(
        "Package publication journal must contain one bounded operation.",
      );
      expect(snapshot()).toEqual(before);
    },
  );
});
