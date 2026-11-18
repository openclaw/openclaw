import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { quarantineOrphanedSqliteSidecars } from "../infra/sqlite-files.js";
import {
  databaseFixture,
  closeDatabases,
  openRawDatabase,
} from "./database-preflight-fixtures.test-support.js";

const tempStateDirs = useAutoCleanupTempDirTracker(afterEach);
const databaseKinds = ["state", "agent"] as const;
const rollbackJournalContents = Buffer.from("recoverable rollback journal content");
const shmIndexContents = Buffer.alloc(32 * 1024, 0x53);
const emptySidecar = Buffer.alloc(0);
const loggerMocks = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) =>
      subsystem === "state/sqlite"
        ? { ...actual.createSubsystemLogger(subsystem), warn: loggerMocks.warn }
        : actual.createSubsystemLogger(subsystem),
  };
});

function createWalFixture(): { header: Buffer; withFrames: Buffer } {
  const fixtureDir = fs.realpathSync(tempStateDirs.make("openclaw-wal-header-"));
  const databasePath = path.join(fixtureDir, "header.sqlite");
  using database = openRawDatabase(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  database.exec("CREATE TABLE header_probe (value TEXT);");
  const wal = fs.readFileSync(`${databasePath}-wal`);
  if (wal.length <= 32) {
    throw new Error("SQLite did not write a WAL frame for the header fixture");
  }
  return { header: Buffer.from(wal.subarray(0, 32)), withFrames: Buffer.from(wal) };
}

const walFixture = createWalFixture();

afterEach(() => {
  closeDatabases();
  loggerMocks.warn.mockReset();
  vi.restoreAllMocks();
});

function prepareCase(kind: (typeof databaseKinds)[number] = "state") {
  const fixture = databaseFixture(fs.realpathSync(tempStateDirs.make("openclaw-orphan-sidecar-")));
  const databasePath = kind === "state" ? fixture.statePath : fixture.agentPath();
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  return { databasePath, open: kind === "state" ? fixture.state : () => fixture.agent() };
}

function listQuarantinePaths(sourcePath: string): string[] {
  const prefix = `${path.basename(sourcePath)}.orphaned-`;
  return fs
    .readdirSync(path.dirname(sourcePath))
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => path.join(path.dirname(sourcePath), entry));
}

const cases = [
  ["real WAL with committed frames", "-wal", walFixture.withFrames, true],
  ["non-empty rollback journal", "-journal", rollbackJournalContents, true],
  ["lone SHM index", "-shm", shmIndexContents, false],
  ["32-byte header-only WAL", "-wal", walFixture.header, false],
  ["zero-byte rollback journal", "-journal", emptySidecar, false],
] as const;
it.each(
  cases.flatMap(([label, suffix, contents, recoverable]) =>
    databaseKinds.map((kind) => [kind, label, suffix, contents, recoverable] as const),
  ),
)("opens a missing %s database with a %s", (kind, _label, suffix, contents, recoverable) => {
  const { databasePath, open } = prepareCase(kind);
  const sourcePath = databasePath + suffix;
  fs.writeFileSync(sourcePath, contents);
  if (recoverable) {
    fs.writeFileSync(databasePath + "-shm", shmIndexContents);
    fs.writeFileSync(
      databasePath + (suffix === "-wal" ? "-journal" : "-wal"),
      suffix === "-wal" ? emptySidecar : walFixture.header,
    );
  }
  const database = open();
  expect([database.db.isOpen, fs.existsSync(databasePath)]).toEqual([true, true]);
  const quarantines = listQuarantinePaths(sourcePath);
  if (!recoverable) {
    expect(database.db.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(quarantines).toEqual([]);
    expect(loggerMocks.warn).not.toHaveBeenCalled();
    return;
  }
  expect(quarantines).toHaveLength(1);
  const [quarantinePath] = quarantines;
  expect(fs.readFileSync(quarantinePath!)).toEqual(contents);
  // A successful WAL-mode open may create a new canonical sidecar.
  if (fs.existsSync(sourcePath)) {
    expect(fs.readFileSync(sourcePath)).not.toEqual(contents);
  }
  expect(loggerMocks.warn).toHaveBeenCalledWith(
    expect.stringContaining("Recovery requires restoring the main database"),
    expect.any(Object),
  );
});

it("preserves a same-size quarantine with different contents and copies to a unique suffix", () => {
  const { databasePath, open } = prepareCase();
  const sourcePath = `${databasePath}-wal`;
  const epochMs = 1_786_738_000_000;
  const existingQuarantinePath = `${sourcePath}.orphaned-${epochMs}`;
  const newQuarantinePath = `${existingQuarantinePath}-1`;
  const existingContents = Buffer.from(walFixture.withFrames);
  existingContents.writeUInt8(existingContents.readUInt8(32) ^ 0xff, 32);
  fs.writeFileSync(sourcePath, walFixture.withFrames);
  fs.writeFileSync(existingQuarantinePath, existingContents);
  vi.spyOn(Date, "now").mockReturnValue(epochMs);

  const database = open();

  expect(database.db.isOpen).toBe(true);
  expect(fs.readFileSync(existingQuarantinePath)).toEqual(existingContents);
  expect(fs.readFileSync(newQuarantinePath)).toEqual(walFixture.withFrames);
});

it.each(["file", ...(process.platform === "win32" ? [] : ["symlink"])] as const)(
  "leaves the live %s sidecar untouched and reuses an identical preserved copy",
  (sourceKind) => {
    const { databasePath } = prepareCase();
    const sourcePath = `${databasePath}-wal`;
    const targetPath = sourceKind === "symlink" ? `${databasePath}-wal-target` : sourcePath;
    fs.writeFileSync(targetPath, walFixture.withFrames);
    if (sourceKind === "symlink") {
      fs.symlinkSync(targetPath, sourcePath);
    }

    quarantineOrphanedSqliteSidecars(databasePath);
    const quarantinePaths = listQuarantinePaths(sourcePath);

    expect(quarantinePaths).toHaveLength(1);
    expect(fs.readFileSync(sourcePath)).toEqual(walFixture.withFrames);
    expect(fs.readFileSync(quarantinePaths[0] ?? "")).toEqual(walFixture.withFrames);
    loggerMocks.warn.mockClear();

    quarantineOrphanedSqliteSidecars(databasePath);

    expect(listQuarantinePaths(sourcePath)).toEqual(quarantinePaths);
    expect(fs.readFileSync(sourcePath)).toEqual(walFixture.withFrames);
    expect(fs.readFileSync(targetPath)).toEqual(walFixture.withFrames);
    expect(fs.lstatSync(sourcePath).isSymbolicLink()).toBe(sourceKind === "symlink");
    if (sourceKind === "symlink") {
      expect(fs.readlinkSync(sourcePath)).toBe(targetPath);
    }
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  },
);

it("fails closed with the typed error when quarantine copy fails", () => {
  const { databasePath, open } = prepareCase();
  const sourcePath = `${databasePath}-wal`;
  fs.writeFileSync(sourcePath, walFixture.withFrames);
  const copyError = Object.assign(new Error("read-only volume"), { code: "EROFS" });
  vi.spyOn(fs, "copyFileSync").mockImplementationOnce(() => {
    throw copyError;
  });

  expect(open).toThrow(
    expect.objectContaining({
      name: "SqliteOrphanedSidecarsError",
      message: expect.stringContaining(sourcePath),
    }),
  );
  expect(fs.existsSync(databasePath)).toBe(false);
  expect(fs.readFileSync(sourcePath)).toEqual(walFixture.withFrames);
  expect(listQuarantinePaths(sourcePath)).toEqual([]);
  expect(loggerMocks.warn).not.toHaveBeenCalled();
});
