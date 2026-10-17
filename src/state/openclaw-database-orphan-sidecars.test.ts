import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { quarantineOrphanedSqliteSidecars } from "../infra/sqlite-files.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

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
  const { DatabaseSync } = requireNodeSqlite();
  using database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  database.exec("CREATE TABLE header_probe (value TEXT);");
  const wal = fs.readFileSync(`${databasePath}-wal`);
  if (wal.length <= 32) {
    throw new Error("SQLite did not write a WAL frame for the header fixture");
  }
  return {
    header: Buffer.from(wal.subarray(0, 32)),
    withFrames: Buffer.from(wal),
  };
}

const walFixture = createWalFixture();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  loggerMocks.warn.mockReset();
  vi.restoreAllMocks();
});

function prepareCase(kind: (typeof databaseKinds)[number]) {
  const stateDir = fs.realpathSync(tempStateDirs.make("openclaw-orphan-sidecar-"));
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const databasePath =
    kind === "state"
      ? resolveOpenClawStateSqlitePath(env)
      : resolveOpenClawAgentSqlitePath({ agentId: "main", env });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  return { databasePath, env };
}

function openDatabase(kind: (typeof databaseKinds)[number], env: NodeJS.ProcessEnv) {
  return kind === "state"
    ? openOpenClawStateDatabase({ env })
    : openOpenClawAgentDatabase({ agentId: "main", env });
}

function listQuarantinePaths(sourcePath: string): string[] {
  const prefix = `${path.basename(sourcePath)}.orphaned-`;
  return fs
    .readdirSync(path.dirname(sourcePath))
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => path.join(path.dirname(sourcePath), entry));
}

describe("orphan SQLite sidecar admission", () => {
  const recoverableCases = [
    [
      "real WAL with committed frames",
      "-wal",
      walFixture.withFrames,
      [
        ["-shm", shmIndexContents],
        ["-journal", emptySidecar],
      ],
    ],
    [
      "non-empty rollback journal",
      "-journal",
      rollbackJournalContents,
      [
        ["-wal", walFixture.header],
        ["-shm", shmIndexContents],
      ],
    ],
  ] as const;

  for (const [label, suffix, contents, benignSidecars] of recoverableCases) {
    for (const kind of databaseKinds) {
      const regression =
        kind === "state" && suffix === "-wal" ? " (plugin lifecycle regression)" : "";
      it(`opens a missing ${kind} database after copying a ${label}${regression}`, () => {
        const { databasePath, env } = prepareCase(kind);
        for (const [sidecar, bytes] of [[suffix, contents], ...benignSidecars] as const) {
          fs.writeFileSync(`${databasePath}${sidecar}`, bytes);
        }

        const database = openDatabase(kind, env);
        const sourcePath = `${databasePath}${suffix}`;
        const quarantinePaths = listQuarantinePaths(sourcePath);

        expect(database.db.isOpen).toBe(true);
        expect(fs.existsSync(databasePath)).toBe(true);
        expect(quarantinePaths).toHaveLength(1);
        const quarantinePath = quarantinePaths.at(0);
        if (!quarantinePath) {
          throw new Error(`missing quarantine for ${sourcePath}`);
        }
        expect(fs.readFileSync(quarantinePath)).toEqual(contents);
        if (fs.existsSync(sourcePath)) {
          // A successful WAL-mode open may create a new sidecar at the canonical path.
          expect(fs.readFileSync(sourcePath)).not.toEqual(contents);
        }
        expect(loggerMocks.warn).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining(quarantinePath),
          expect.objectContaining({
            databasePath,
            copiedSidecars: [{ quarantinePath, sourcePath }],
          }),
        );
        expect(String(loggerMocks.warn.mock.calls[0]?.[0])).toContain(
          "Committed frames could not be applied because the main database is missing",
        );
        expect(String(loggerMocks.warn.mock.calls[0]?.[0])).toContain(
          "Recovery requires restoring the main database and pairing it with the quarantined file",
        );
      });
    }
  }

  const nonBlockingCases = [
    ["lone SHM index", "-shm", shmIndexContents],
    ["32-byte header-only WAL", "-wal", walFixture.header],
    ["zero-byte rollback journal", "-journal", emptySidecar],
  ] as const;

  for (const [label, suffix, contents] of nonBlockingCases) {
    for (const kind of databaseKinds) {
      it(`creates a missing ${kind} database with a ${label}`, () => {
        const { databasePath, env } = prepareCase(kind);
        fs.writeFileSync(`${databasePath}${suffix}`, contents);

        const database = openDatabase(kind, env);

        expect(database.db.isOpen).toBe(true);
        expect(fs.existsSync(databasePath)).toBe(true);
        expect(database.db.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
        expect(listQuarantinePaths(`${databasePath}${suffix}`)).toEqual([]);
        expect(loggerMocks.warn).not.toHaveBeenCalled();
      });
    }
  }

  it("preserves a same-size quarantine with different contents and copies to a unique suffix", () => {
    const { databasePath, env } = prepareCase("state");
    const sourcePath = `${databasePath}-wal`;
    const epochMs = 1_786_738_000_000;
    const existingQuarantinePath = `${sourcePath}.orphaned-${epochMs}`;
    const newQuarantinePath = `${existingQuarantinePath}-1`;
    const existingContents = Buffer.from(walFixture.withFrames);
    existingContents.writeUInt8(existingContents.readUInt8(32) ^ 0xff, 32);
    fs.writeFileSync(sourcePath, walFixture.withFrames);
    fs.writeFileSync(existingQuarantinePath, existingContents);
    vi.spyOn(Date, "now").mockReturnValue(epochMs);

    const database = openDatabase("state", env);

    expect(database.db.isOpen).toBe(true);
    expect(fs.readFileSync(existingQuarantinePath)).toEqual(existingContents);
    expect(fs.readFileSync(newQuarantinePath)).toEqual(walFixture.withFrames);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.stringContaining(newQuarantinePath),
      expect.any(Object),
    );
  });

  for (const sourceKind of ["file", "symlink"] as const) {
    it.skipIf(sourceKind === "symlink" && process.platform === "win32")(
      `leaves the live ${sourceKind} sidecar untouched and reuses an identical preserved copy`,
      () => {
        const { databasePath } = prepareCase("state");
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
  }

  it("fails closed with the typed error when quarantine copy fails", () => {
    const { databasePath, env } = prepareCase("state");
    const sourcePath = `${databasePath}-wal`;
    fs.writeFileSync(sourcePath, walFixture.withFrames);
    const copyError = Object.assign(new Error("read-only volume"), { code: "EROFS" });
    vi.spyOn(fs, "copyFileSync").mockImplementationOnce(() => {
      throw copyError;
    });

    let thrown: unknown;
    try {
      openDatabase("state", env);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("SqliteOrphanedSidecarsError");
    expect((thrown as Error).message).toContain(databasePath);
    expect((thrown as Error).message).toContain(sourcePath);
    expect((thrown as Error).message).toContain("restore the main database");
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(fs.readFileSync(sourcePath)).toEqual(walFixture.withFrames);
    expect(listQuarantinePaths(sourcePath)).toEqual([]);
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });
});
