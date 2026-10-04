import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installPrivateUpdateHandoffStore,
  writePrivateUpdateHandoffChildGuard,
} from "../../test/helpers/private-update-handoff-store.js";
import { createHotSqliteRollbackJournal } from "../../test/helpers/sqlite-hot-journal.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import * as nodeSqlite from "./node-sqlite.js";
import {
  createPackageActivationJournal,
  openPackageActivationJournal,
  resolvePackageActivationJournalPath,
  resolvePackageActivationHelper,
  resolvePackageActivationControl,
  packageActivationIdentity,
  resolvePackageActivationAnchor,
  type PackageActivationDescriptor,
  type PackageActivationIntent,
  type PackageActivationPhase,
  type PackageActivationRecord,
} from "./package-update-activation-journal.js";
import {
  readPackageActivationStatus,
  runPackageActivationRecovery,
} from "./package-update-activation.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const openDatabase = nodeSqlite.openNodeSqliteDatabase;
let root: string;
let assertDatabasePath: (path: string) => void;
let childGuardEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;

beforeEach(() => {
  root = fs.realpathSync(dirs.make("package-activation-journal-"));
  const temporary = path.join(root, "private-tmp");
  fs.mkdirSync(temporary, { mode: 0o700 });
  ({ assertDatabasePath } = installPrivateUpdateHandoffStore(temporary));
  childGuardEnv = writePrivateUpdateHandoffChildGuard(
    path.join(temporary, "managed-update-handoffs.sqlite"),
    temporary,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
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
  const env = writePrivateUpdateHandoffChildGuard(
    privatePath,
    path.dirname(privatePath),
  )({
    ...process.env,
  });
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
  const blockedResults = [];
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
  for (const livePath of refusedPaths) {
    // Refuse the probe itself if the runtime did not install the guard.
    const blocked = spawnSync(
      process.execPath,
      [
        "-e",
        `${requireGuard}new (require('node:sqlite').DatabaseSync)(${JSON.stringify(livePath)})`,
      ],
      { env, encoding: "utf8" },
    );
    blockedResults.push(blocked);
  }
  expect(blockedResults.map((result) => result.status)).toEqual(refusedPaths.map(() => 1));
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
    const accepted = spawnSync(
      process.execPath,
      [
        "-e",
        `${requireGuard}new (require('node:sqlite').DatabaseSync)(${JSON.stringify(privateDatabase)}).close()`,
      ],
      { env, encoding: "utf8" },
    );
    expect(accepted.error).toBeUndefined();
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(fs.realpathSync(privateDatabase)).toBe(privateDatabase);
    for (const uri of [
      nodeSqlite.resolveExistingSqliteFileUri(privateDatabase),
      nodeSqlite.resolveImmutableSqliteFileUri(privateDatabase),
    ]) {
      const reopened = spawnSync(
        process.execPath,
        [
          "-e",
          `${requireGuard}new (require('node:sqlite').DatabaseSync)(${JSON.stringify(uri)}).close()`,
        ],
        { env, encoding: "utf8" },
      );
      expect(reopened.error).toBeUndefined();
      expect(reopened.status, reopened.stderr).toBe(0);
    }
  }
});

async function fixture() {
  const packages = await createPackageSwapFixture(root);
  const anchor = resolvePackageActivationAnchor(packages.packageRoot);
  const stagedAnchor = `${anchor}.staged`;
  const launcherRoot = path.join(stagedAnchor, "launchers");
  fs.mkdirSync(stagedAnchor, { mode: 0o700 });
  fs.mkdirSync(launcherRoot, { mode: 0o700 });
  const stagedControl = resolvePackageActivationControl(stagedAnchor);
  fs.mkdirSync(stagedControl, { mode: 0o700 });
  const helperBytes = Buffer.from("// sealed helper fixture\n");
  fs.writeFileSync(resolvePackageActivationHelper(stagedAnchor), helperBytes, { mode: 0o600 });
  const initial = await withUpdateCommandExecutor(randomUUID(), async (executor) => {
    const fence = await executor.enter(packages.packageRoot);
    const authority = captureUpdateCommandExecutorAuthority(fence);
    const descriptor: Omit<PackageActivationDescriptor, "journalIdentity"> = {
      version: 1,
      layout: "external-helper",
      recoveryNodePath: fs.realpathSync(process.execPath),
      helperIdentity: packageActivationIdentity(
        resolvePackageActivationHelper(stagedAnchor),
        false,
      ),
      preparation: [
        {
          name: "anchor",
          source: stagedAnchor,
          sourceParentIdentity: packageActivationIdentity(path.dirname(stagedAnchor), true),
          identity: packageActivationIdentity(stagedAnchor, true),
        },
        {
          name: "helper",
          source: resolvePackageActivationHelper(anchor),
          sourceParentIdentity: packageActivationIdentity(stagedControl, true),
          identity: packageActivationIdentity(resolvePackageActivationHelper(stagedAnchor), false),
        },
        {
          name: "candidate",
          source: packages.params.stage.packageRoot,
          sourceParentIdentity: packageActivationIdentity(
            path.dirname(packages.params.stage.packageRoot),
            true,
          ),
          identity: packageActivationIdentity(packages.params.stage.packageRoot, true),
        },
        {
          name: "launchers",
          source: packages.params.stage.layout.binDir,
          sourceParentIdentity: packageActivationIdentity(
            path.dirname(packages.params.stage.layout.binDir),
            true,
          ),
          identity: packageActivationIdentity(launcherRoot, true),
        },
      ],
      operationId: randomUUID(),
      authority,
      anchorIdentity: packageActivationIdentity(stagedAnchor, true),
      parentIdentity: packageActivationIdentity(path.dirname(anchor), true),
      journalParentIdentity: packageActivationIdentity(stagedControl, true),
      binDir: path.dirname(packages.launcher),
      binIdentity: packageActivationIdentity(path.dirname(packages.launcher), true),
      originalStageRoot: packages.params.stage.packageRoot,
      previous: {
        digest: "a".repeat(64),
        identity: packageActivationIdentity(packages.packageRoot, true),
        version: "1.0.0",
      },
      candidate: {
        digest: "b".repeat(64),
        identity: packageActivationIdentity(packages.params.stage.packageRoot, true),
        version: "2.0.0",
      },
      launcherRootIdentity: packageActivationIdentity(launcherRoot, true),
      previousLauncherRootIdentity: null,
      helperDigest: createHash("sha256").update(helperBytes).digest("hex"),
      launchers: [
        {
          name: "openclaw",
          previous: "old launcher\n",
          candidate: "candidate launcher\n",
          previousIdentity: packageActivationIdentity(packages.launcher, "launcher"),
          candidateIdentity: packageActivationIdentity(
            path.join(packages.params.stage.layout.binDir, "openclaw"),
            "launcher",
          ),
        },
      ],
    };
    const journal = createPackageActivationJournal(
      anchor,
      descriptor,
      stagedControl,
      fence.assertCurrent,
    );
    fs.renameSync(stagedAnchor, anchor);
    return {
      authority,
      journal,
      record: journal.transition(journal.read(), "prepared", null, fence.assertCurrent),
    };
  });
  const journalPath = resolvePackageActivationJournalPath(anchor);
  const transition = (
    record: PackageActivationRecord,
    phase: PackageActivationPhase,
    intent: PackageActivationIntent,
  ) =>
    withUpdateCommandExecutor(
      randomUUID(),
      async (executor) => {
        const fence = await executor.enter(packages.packageRoot);
        return initial.journal.transition(record, phase, intent, fence.assertCurrent);
      },
      { existingAuthority: initial.authority },
    );
  return { ...packages, ...initial, anchor, journalPath, transition };
}

function journalFiles(anchor: string) {
  return fs
    .readdirSync(resolvePackageActivationControl(anchor))
    .toSorted()
    .map((name) => {
      const file = path.join(resolvePackageActivationControl(anchor), name);
      const stat = fs.lstatSync(file);
      return {
        name,
        mode: stat.mode,
        ino: stat.ino,
        content: stat.isFile() ? fs.readFileSync(file) : undefined,
      };
    });
}

function replaceField(
  journalPath: string,
  column: "descriptor_json" | "revision" | "phase" | "intent_json" | "publications_json",
  value: string | number,
) {
  const db = new DatabaseSync(journalPath);
  try {
    db.prepare(`UPDATE package_activation SET ${column} = ? WHERE slot = 1`).run(value);
  } finally {
    db.close();
  }
}

function createHotJournal(journalPath: string) {
  createHotSqliteRollbackJournal({
    path: journalPath,
    mutationSql: "UPDATE package_activation SET phase = 'publication-complete'",
    env: childGuardEnv({}),
  });
}

describe.skipIf(process.platform === "win32")("package activation journal", () => {
  it.each([false, true])(
    "preserves a hot journal until recovery admission (replaced=%s)",
    async (replaced) => {
      const f = await fixture();
      createHotJournal(f.journalPath);
      const rollbackPath = `${f.journalPath}-journal`;
      expect(fs.statSync(rollbackPath).size).toBeGreaterThan(512);
      const before = journalFiles(f.anchor);
      const readOnly = new DatabaseSync(f.journalPath, { readOnly: true });
      try {
        expect(() => readOnly.prepare("SELECT phase FROM package_activation").get()).toThrow(
          expect.objectContaining({ errcode: 776 }),
        );
      } finally {
        readOnly.close();
      }
      await expect(
        readPackageActivationStatus(f.anchor, f.record.descriptor.operationId),
      ).rejects.toThrow();
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
      const f = await fixture();
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
        await expect(
          readPackageActivationStatus(f.anchor, f.record.descriptor.operationId),
        ).rejects.toThrow();
        expect(journalFiles(f.anchor)).toEqual(before);
        await expect(
          runPackageActivationRecovery(f.anchor, "repair", f.record.descriptor.operationId),
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
    const f = await fixture();
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
    expect(record).toMatchObject({ revision: 1, phase: "prepared", intent: null });
    const publishing = await f.transition(record, "publishing", { kind: "displace" });
    expect(publishing).toMatchObject({
      revision: 2,
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
      revision: 4,
      phase: "rolled-back",
      descriptor: record.descriptor,
    });
    const db = new DatabaseSync(f.journalPath, { readOnly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM package_activation").get()).toEqual({
        count: 1,
      });
    } finally {
      db.close();
    }
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
    const f = await fixture();
    if (column === null) {
      const db = new DatabaseSync(f.journalPath);
      try {
        db.exec(value());
      } finally {
        db.close();
      }
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
      const f = await fixture();
      const disarmed = await f.transition(f.record, phase, null);
      const before = journalFiles(f.anchor);
      await expect(
        readPackageActivationStatus(f.anchor, f.record.descriptor.operationId),
      ).resolves.toEqual({
        phase,
        operationId: disarmed.descriptor.operationId,
        installKey: f.packageRoot,
      });
      await expect(
        runPackageActivationRecovery(f.anchor, "repair", f.record.descriptor.operationId),
      ).rejects.toThrow(`Forward publication is disarmed (${phase})`);
      expect(journalFiles(f.anchor)).toEqual(before);
      expect(fs.existsSync(f.params.stage.packageRoot)).toBe(true);
      expect(fs.readFileSync(f.launcher, "utf8")).toBe("old launcher\n");
      expect(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).toContain(
        '"version":"1.0.0"',
      );
    },
  );

  it("observes a committed intent after its acknowledgement is lost", async () => {
    const f = await fixture();
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
      revision: 2,
      phase: "publishing",
      intent: { kind: "displace" },
      descriptor: f.record.descriptor,
    });
    expect(() => f.journal.assertCurrent(f.record)).toThrow("no longer current");
    const disarmed = await f.transition(committed, "rollback-in-progress", null);
    expect(disarmed.revision).toBe(3);
    expect(fs.existsSync(f.params.stage.packageRoot)).toBe(true);
    expect(fs.readFileSync(f.launcher, "utf8")).toBe("old launcher\n");
  });

  it("preserves the current intent when its live executor refuses the write", async () => {
    const f = await fixture();
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

function byteBoundsFixture(oversized: (typeof jsonColumns)[number]) {
  const anchor = path.join(dirs.make("package-journal-byte-bound-"), "anchor");
  fs.mkdirSync(anchor, { mode: 0o700 });
  fs.mkdirSync(resolvePackageActivationControl(anchor), { mode: 0o700 });
  const file = resolvePackageActivationJournalPath(anchor);
  const db = new DatabaseSync(file);
  try {
    db.exec(
      "CREATE TABLE package_activation (slot INTEGER, revision INTEGER, phase TEXT, descriptor_json TEXT, intent_json TEXT, publications_json TEXT)",
    );
    const row = { descriptor_json: "{", intent_json: "null", publications_json: "[]" };
    // Under one million characters, but over the one MiB byte bound.
    row[oversized] = "é".repeat(512 * 1024 + 1);
    db.prepare("INSERT INTO package_activation VALUES (1, 0, 'prepared', ?, ?, ?)").run(
      row.descriptor_json,
      row.intent_json,
      row.publications_json,
    );
  } finally {
    db.close();
  }
  fs.chmodSync(file, 0o600);
  const snapshot = () => {
    const stat = fs.statSync(file);
    return {
      names: fs.readdirSync(anchor),
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      mtime: stat.mtimeMs,
      digest: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    };
  };
  return { anchor, snapshot };
}

describe.skipIf(process.platform === "win32")("existing package journal byte bounds", () => {
  it.each(jsonColumns)(
    "refuses oversized %s before decoding without modifying the original journal",
    (column) => {
      const { anchor, snapshot } = byteBoundsFixture(column);
      const before = snapshot();
      expect(() => openPackageActivationJournal(anchor).read()).toThrow(
        "Package publication journal must contain one bounded operation.",
      );
      expect(snapshot()).toEqual(before);
    },
  );
});
