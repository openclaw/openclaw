import childProcess from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";
import {
  probeSqliteDatabaseHeaders,
  SQLITE_HEADER_PROBE_BATCH_SIZE,
} from "./sqlite-header-probe.js";

afterEach(() => vi.restoreAllMocks());

it("probes a batch through a declared worker using the current runtime without eval", async () => {
  await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
    const sqlitePath = state.path("candidate.db");
    const plainPath = state.path("plain.db");
    await fs.writeFile(sqlitePath, "SQLite format 3\0");
    await fs.writeFile(plainPath, "plain bytes");
    const spawn = vi.spyOn(childProcess, "spawnSync");

    expect(probeSqliteDatabaseHeaders([sqlitePath, plainPath, sqlitePath])).toEqual(
      new Map([
        [sqlitePath, true],
        [plainPath, false],
      ]),
    );
    expect(spawn).toHaveBeenCalledOnce();
    const [executable, argv] = spawn.mock.calls[0]!;
    expect(executable).toBe(process.execPath);
    expect(argv).not.toContain("-e");
    expect(argv?.at(-1)).toMatch(/[/\\]sqlite-header-probe\.worker\.[jt]s$/);
  });
});

it("gives every probe batch its own deadline and reports why a batch failed", async () => {
  await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
    const sqlitePath = state.path("last.db");
    await fs.writeFile(sqlitePath, "SQLite format 3\0");
    const missing = Array.from({ length: SQLITE_HEADER_PROBE_BATCH_SIZE * 2 }, (_, index) =>
      state.path(`missing-${index}`),
    );
    const spawn = vi.spyOn(childProcess, "spawnSync");

    const answers = probeSqliteDatabaseHeaders([...missing, sqlitePath]);
    expect([answers.size, answers.get(sqlitePath), spawn.mock.calls.length]).toEqual([
      missing.length + 1,
      true,
      3,
    ]);
    spawn.mockReturnValueOnce({
      error: Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" }),
    } as never);
    expect(() => probeSqliteDatabaseHeaders([sqlitePath])).toThrow(
      /Cause: spawnSync node ETIMEDOUT/,
    );
  });
});

// Archive-owner regression for the isolated header probe (#148796): when the
// probe cannot answer for a retained candidate, backup creation must abort
// before any archive is published instead of guessing the file is plain bytes.
describe("createBackupArchive SQLite header probe failure", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses to publish an archive when the header probe cannot read a retained candidate",
    async () => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-backup-probe-failure-",
          scenario: "minimal",
        },
        async (state) => {
          const dbPath = state.statePath("notes", "unreadable-candidate.db");
          await fs.mkdir(path.dirname(dbPath), { recursive: true });
          await fs.writeFile(dbPath, "retained candidate the probe cannot read");
          await fs.chmod(dbPath, 0o000);
          const outputDir = state.path("backups");
          await fs.mkdir(outputDir, { recursive: true });
          try {
            await expect(
              createBackupArchive({
                output: outputDir,
                includeWorkspace: false,
                nowMs: Date.UTC(2026, 9, 25, 4, 0, 0),
              }),
            ).rejects.toThrow(/Could not determine whether backup files are SQLite databases/);
            await expect(fs.readdir(outputDir)).resolves.toEqual([]);
          } finally {
            await fs.chmod(dbPath, 0o600).catch(() => {});
          }
        },
      );
    },
  );
});
