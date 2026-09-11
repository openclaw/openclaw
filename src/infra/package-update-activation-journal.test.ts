import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertReliabilityForcedExit } from "../../scripts/lib/sqlite-reliability-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import * as nodeSqlite from "./node-sqlite.js";
import {
  createPackageActivationJournal,
  openPackageActivationJournal,
  PACKAGE_ACTIVATION_JOURNAL,
  packageActivationIdentity,
  resolvePackageActivationAnchor,
  type PackageActivationDescriptor,
  type PackageActivationIntent,
  type PackageActivationPhase,
  type PackageActivationRecord,
} from "./package-update-activation-journal.js";
import { PACKAGE_ACTIVATION_HELPER } from "./package-update-activation-runtime-assets.js";
import {
  readPackageActivationStatus,
  runPackageActivationRecovery,
} from "./package-update-activation.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import * as tempRoot from "./tmp-openclaw-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const openDatabase = nodeSqlite.openNodeSqliteDatabase;
let root: string;

beforeEach(() => {
  root = fs.realpathSync(dirs.make("package-activation-journal-"));
  const temporary = path.join(root, "private-tmp");
  fs.mkdirSync(temporary, { mode: 0o700 });
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture() {
  const packages = await createPackageSwapFixture(root);
  const anchor = resolvePackageActivationAnchor(packages.packageRoot);
  const launcherRoot = path.join(anchor, "launchers");
  fs.mkdirSync(anchor, { mode: 0o700 });
  fs.mkdirSync(launcherRoot, { mode: 0o700 });
  const helperBytes = Buffer.from("// sealed helper fixture\n");
  fs.writeFileSync(path.join(anchor, PACKAGE_ACTIVATION_HELPER), helperBytes, { mode: 0o600 });
  const initial = await withUpdateCommandExecutor(randomUUID(), async (executor) => {
    const fence = await executor.enter(packages.packageRoot);
    const authority = captureUpdateCommandExecutorAuthority(fence);
    const descriptor: Omit<PackageActivationDescriptor, "journalIdentity"> = {
      version: 1,
      operationId: randomUUID(),
      authority,
      anchorIdentity: packageActivationIdentity(anchor, true),
      parentIdentity: packageActivationIdentity(path.dirname(anchor), true),
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
    const journal = createPackageActivationJournal(anchor, descriptor, fence.assertCurrent);
    return { authority, journal, record: journal.read() };
  });
  const journalPath = path.join(anchor, PACKAGE_ACTIVATION_JOURNAL);
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
    .readdirSync(anchor)
    .toSorted()
    .map((name) => {
      const file = path.join(anchor, name);
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

describe.skipIf(process.platform === "win32")("package activation journal", () => {
  it("status refuses a real hot rollback journal without recovering or changing its files", async () => {
    const f = await fixture();
    const setup = new DatabaseSync(f.journalPath);
    try {
      setup.exec(`
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = FULL;
        CREATE TABLE hot_journal_pressure (
          id INTEGER PRIMARY KEY,
          value TEXT NOT NULL,
          payload BLOB NOT NULL
        ) STRICT;
        WITH RECURSIVE rows(id) AS (
          SELECT 1 UNION ALL SELECT id + 1 FROM rows WHERE id < 256
        )
        INSERT INTO hot_journal_pressure
        SELECT id, 'committed', zeroblob(8192) FROM rows;
      `);
    } finally {
      setup.close();
    }
    // Match the existing sqlite-snapshot crash fixture: spill a real uncommitted
    // write, then join the exact child that leaves the native rollback journal.
    const crashed = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--input-type=module",
        "-e",
        `
          import { DatabaseSync } from "node:sqlite";
          const database = new DatabaseSync(process.argv[1]);
          database.exec(
            "PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; " +
            "PRAGMA cache_size = 2; PRAGMA cache_spill = ON; BEGIN IMMEDIATE; " +
            "UPDATE package_activation SET phase = 'publication-complete'; " +
            "UPDATE hot_journal_pressure SET value = 'uncommitted';"
          );
          process.kill(process.pid, "SIGKILL");
        `,
        f.journalPath,
      ],
      { env: {}, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
    );
    expect(crashed.error, crashed.stderr).toBeUndefined();
    assertReliabilityForcedExit(
      { code: crashed.status, signal: crashed.signal },
      "activation hot-journal fixture",
    );
    const rollbackPath = `${f.journalPath}-journal`;
    expect(fs.statSync(rollbackPath).size).toBeGreaterThan(512);
    const before = journalFiles(f.anchor);
    const readOnly = new DatabaseSync(f.journalPath, { readOnly: true });
    try {
      let refusal: unknown;
      try {
        readOnly.prepare("SELECT phase FROM package_activation").get();
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({ errcode: 776 });
    } finally {
      readOnly.close();
    }
    await expect(readPackageActivationStatus(f.anchor)).rejects.toThrow();
    expect(journalFiles(f.anchor)).toEqual(before);
    expect(fs.existsSync(`${f.journalPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${f.journalPath}-shm`)).toBe(false);
  });

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
        await expect(readPackageActivationStatus(f.anchor)).rejects.toThrow();
        expect(journalFiles(f.anchor)).toEqual(before);
      } finally {
        if (database.isOpen) {
          database.close();
        }
      }
    },
  );

  it("keeps one bounded descriptor while exact-revision intents advance", async () => {
    const f = await fixture();
    expect(f.record).toMatchObject({ revision: 0, phase: "prepared", intent: null });
    const publishing = await f.transition(f.record, "publishing", { kind: "displace" });
    expect(publishing).toMatchObject({
      revision: 1,
      phase: "publishing",
      intent: { kind: "displace" },
      descriptor: f.record.descriptor,
    });
    await expect(f.transition(f.record, "publication-complete", null)).rejects.toThrow(
      "no longer current",
    );
    expect(f.journal.read()).toEqual(publishing);
    const disarmed = await f.transition(publishing, "rollback-in-progress", null);
    const restored = await f.transition(disarmed, "rolled-back", null);
    expect(openPackageActivationJournal(f.anchor).read()).toEqual(restored);
    expect(restored).toMatchObject({
      revision: 3,
      phase: "rolled-back",
      descriptor: f.record.descriptor,
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
    {
      name: "oversized UTF-8 descriptor",
      column: "descriptor_json",
      value: (record: PackageActivationRecord) => {
        const value = JSON.stringify({
          ...record.descriptor,
          launchers: Array.from({ length: 64 }, (_, index) => ({
            ...record.descriptor.launchers[0]!,
            name: `launcher-${index}`,
            previous: "\u754c".repeat(4096),
            candidate: "\u754c".repeat(4096),
          })),
        });
        expect(value.length).toBeLessThan(1024 * 1024);
        expect(Buffer.byteLength(value)).toBeGreaterThan(1024 * 1024);
        return value;
      },
    },
  ] as const)("preserves a journal with $name", async ({ column, value }) => {
    const f = await fixture();
    replaceField(f.journalPath, column, value(f.record));
    const before = journalFiles(f.anchor);
    expect(() => openPackageActivationJournal(f.anchor).read()).toThrow();
    await expect(f.transition(f.record, "publishing", { kind: "displace" })).rejects.toThrow();
    expect(journalFiles(f.anchor)).toEqual(before);
  });

  it.each(["missing", "additional"] as const)(
    "refuses a journal with a %s operation without changing it",
    async (kind) => {
      const f = await fixture();
      const db = new DatabaseSync(f.journalPath);
      try {
        db.exec(
          kind === "missing"
            ? "DELETE FROM package_activation"
            : "INSERT INTO package_activation SELECT 2, revision, phase, descriptor_json, intent_json, publications_json FROM package_activation WHERE slot = 1",
        );
      } finally {
        db.close();
      }
      const before = journalFiles(f.anchor);
      expect(() => f.journal.read()).toThrow();
      await expect(f.transition(f.record, "publishing", { kind: "displace" })).rejects.toThrow();
      expect(journalFiles(f.anchor)).toEqual(before);
    },
  );

  it("accepts all 64 bounded launcher entries", async () => {
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
    expect(await f.transition(record, "publishing", { kind: "displace" })).toMatchObject({
      revision: 1,
      descriptor: { launchers },
    });
  });

  it.each(["rollback-in-progress", "rolled-back", "aborted", "retiring", "retired"] as const)(
    "refuses forward repair after %s is durable",
    async (phase) => {
      const f = await fixture();
      const disarmed = await f.transition(f.record, phase, null);
      const before = journalFiles(f.anchor);
      await expect(readPackageActivationStatus(f.anchor)).resolves.toEqual({
        phase,
        operationId: disarmed.descriptor.operationId,
        installKey: f.packageRoot,
      });
      await expect(runPackageActivationRecovery(f.anchor, "repair")).rejects.toThrow(
        `Forward publication is disarmed (${phase})`,
      );
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
      revision: 1,
      phase: "publishing",
      intent: { kind: "displace" },
      descriptor: f.record.descriptor,
    });
    expect(() => f.journal.assertCurrent(f.record)).toThrow("no longer current");
    const disarmed = await f.transition(committed, "rollback-in-progress", null);
    expect(disarmed.revision).toBe(2);
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

function byteBoundsFixture(oversized?: (typeof jsonColumns)[number]) {
  const anchor = dirs.make("package-journal-byte-bound-");
  fs.chmodSync(anchor, 0o700);
  const file = path.join(anchor, PACKAGE_ACTIVATION_JOURNAL);
  const db = new DatabaseSync(file);
  try {
    db.exec(
      "CREATE TABLE package_activation (slot INTEGER, revision INTEGER, phase TEXT, descriptor_json TEXT, intent_json TEXT, publications_json TEXT)",
    );
    const row = { descriptor_json: "{", intent_json: "null", publications_json: "[]" };
    if (oversized) {
      // Under one million characters, but over the one MiB byte bound.
      row[oversized] = "é".repeat(512 * 1024 + 1);
    }
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

describe("existing package journal byte bounds", () => {
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

  it("passes bounded bytes to the decoder and preserves malformed input", () => {
    const { anchor, snapshot } = byteBoundsFixture();
    const before = snapshot();
    expect(() => openPackageActivationJournal(anchor).read()).toThrow(SyntaxError);
    expect(snapshot()).toEqual(before);
  });
});
