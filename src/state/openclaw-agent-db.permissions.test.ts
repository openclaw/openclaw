import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const chmodFailHook = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  calls: [] as unknown[],
  removeTarget: undefined as string | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const chmodSync: typeof actual.chmodSync = ((target: unknown, mode: unknown) => {
    chmodFailHook.calls.push(target);
    if (chmodFailHook.error) {
      throw chmodFailHook.error;
    }
    if (chmodFailHook.removeTarget && target === chmodFailHook.removeTarget) {
      actual.unlinkSync(chmodFailHook.removeTarget);
    }
    return (actual.chmodSync as (...args: unknown[]) => unknown)(target, mode);
  }) as typeof actual.chmodSync;
  const statSync = vi.fn(actual.statSync);
  return { ...actual, chmodSync, statSync, default: { ...actual, chmodSync, statSync } };
});

const {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} = await import("./openclaw-agent-db.js");
const { closeOpenClawStateDatabaseForTest } = await import("./openclaw-state-db.js");
const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
const mockedFs = await import("node:fs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("agent database permission repair", () => {
  afterEach(() => {
    chmodFailHook.error = undefined;
    chmodFailHook.calls = [];
    chmodFailHook.removeTarget = undefined;
    vi.mocked(mockedFs.statSync).mockReset().mockImplementation(fs.statSync);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("rolls back an outer write when pre-commit permission repair fails", () => {
    const stateDir = tempDirs.make("openclaw-agent-chmod-");
    const options = {
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    };
    const database = openOpenClawAgentDatabase(options);
    const before = database.db
      .prepare("SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'")
      .get() as { updated_at: number };
    const permissionError = Object.assign(new Error("EACCES: chmod failed"), {
      code: "EACCES",
    });
    if (process.platform !== "win32") {
      fs.chmodSync(database.path, 0o644);
    }
    chmodFailHook.error = permissionError;

    expect(() =>
      runOpenClawAgentWriteTransaction((writeDatabase) => {
        writeDatabase.db
          .prepare("UPDATE schema_meta SET updated_at = ? WHERE meta_key = 'primary'")
          .run(before.updated_at + 1);
      }, options),
    ).toThrow(permissionError);

    chmodFailHook.error = undefined;
    expect(
      database.db.prepare("SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'").get(),
    ).toEqual(before);

    runOpenClawAgentWriteTransaction((writeDatabase) => {
      writeDatabase.db
        .prepare("UPDATE schema_meta SET updated_at = ? WHERE meta_key = 'primary'")
        .run(before.updated_at + 2);
    }, options);
    expect(
      database.db.prepare("SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'").get(),
    ).toEqual({ updated_at: before.updated_at + 2 });
  });

  it.runIf(process.platform !== "win32")(
    "leaves private modes untouched and repairs fresh permission drift before commit",
    () => {
      const options = {
        agentId: "worker-1",
        env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-agent-chmod-") },
      };
      const database = openOpenClawAgentDatabase(options);
      const directory = path.dirname(database.path);
      const files = [database.path, `${database.path}-wal`, `${database.path}-shm`];
      const targets = new Set([directory, ...files]);
      const write = () =>
        runOpenClawAgentWriteTransaction(({ db }) => {
          db.prepare("UPDATE schema_meta SET updated_at = updated_at + 1").run();
        }, options);

      chmodFailHook.calls = [];
      write();
      expect(chmodFailHook.calls.filter((target) => targets.has(String(target)))).toEqual([]);

      fs.chmodSync(directory, 0o1700);
      fs.chmodSync(database.path, 0o4600);
      for (const file of files.slice(1)) {
        fs.chmodSync(file, 0o644);
      }
      write();
      expect(fs.statSync(directory).mode & 0o7777).toBe(0o700);
      for (const file of files) {
        expect(fs.statSync(file).mode & 0o7777).toBe(0o600);
      }

      chmodFailHook.calls = [];
      write();
      expect(chmodFailHook.calls.filter((target) => targets.has(String(target)))).toEqual([]);
    },
  );

  it.runIf(process.platform !== "win32")("rolls back when the fresh mode cannot be read", () => {
    const options = {
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-agent-stat-") },
    };
    const database = openOpenClawAgentDatabase(options);
    const read = () => database.db.prepare("SELECT updated_at FROM schema_meta").get();
    const before = read();
    const error = Object.assign(new Error("EACCES: stat failed"), { code: "EACCES" });

    expect(() =>
      runOpenClawAgentWriteTransaction(({ db }) => {
        db.prepare("UPDATE schema_meta SET updated_at = updated_at + 1").run();
        vi.mocked(mockedFs.statSync).mockImplementationOnce(() => {
          throw error;
        });
      }, options),
    ).toThrow(error);
    expect(read()).toEqual(before);
  });

  it("commits when a transient sidecar disappears during permission repair", () => {
    const options = {
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-agent-sidecar-") },
    };
    const database = openOpenClawAgentDatabase(options);
    const journal = `${database.path}-journal`;
    const read = () => database.db.prepare("SELECT updated_at FROM schema_meta").get();
    const before = read();
    runOpenClawAgentWriteTransaction(({ db }) => {
      db.prepare("UPDATE schema_meta SET updated_at = updated_at + 1").run();
      fs.writeFileSync(journal, "", { mode: 0o644 });
      fs.chmodSync(journal, 0o644);
      chmodFailHook.removeTarget = journal;
    }, options);
    expect(fs.existsSync(journal)).toBe(false);
    expect(read()).toEqual({ updated_at: Number(before?.updated_at) + 1 });
  });
});
