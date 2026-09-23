import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../../infra/update-managed-service-handoff-lease.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import * as pidAlive from "../../shared/pid-alive.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import {
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const openDatabase = nodeSqlite.openNodeSqliteDatabase;
let root: string;
let directory: string;
let databasePath: string;
let opened: DatabaseSync[];
let leasePreparations: DatabaseSync[];

beforeEach(() => {
  root = fs.realpathSync(dirs.make("update-executor-reader-"));
  directory = path.join(root, "private-tmp");
  fs.mkdirSync(directory, { mode: 0o700 });
  databasePath = path.join(directory, "managed-update-handoffs.sqlite");
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(directory);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  expect(resolveManagedUpdateLeaseDatabasePath()).toBe(databasePath);
  opened = [];
  leasePreparations = [];
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((location, options) => {
    const database = openDatabase(location, options);
    try {
      if (location.includes("managed-update-handoffs.sqlite")) {
        opened.push(database);
        // SQLite reports namespaced Windows paths; compare their native targets.
        expect(fs.realpathSync.native(database.location()!)).toBe(
          fs.realpathSync.native(databasePath),
        );
        const prepare = database.prepare.bind(database);
        database.prepare = (sql) => {
          if (options?.readOnly && sql.startsWith('select "owner", "payload_json", "updated_at"')) {
            leasePreparations.push(database);
          }
          return prepare(sql);
        };
      }
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  });
});

afterEach(() => {
  try {
    expect(opened.every((database) => !database.isOpen)).toBe(true);
  } finally {
    for (const database of opened) {
      if (database.isOpen) {
        database.close();
      }
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

function write(operation: (database: DatabaseSync) => void) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout=0");
    operation(database);
  } finally {
    database.close();
  }
}

function snapshot() {
  return fs
    .readdirSync(root, { recursive: true })
    .toSorted((left, right) => String(left).localeCompare(String(right)))
    .map((relative) => {
      const name = String(relative);
      const file = path.join(root, name);
      const stat = fs.lstatSync(file);
      return {
        name,
        mode: stat.mode,
        identity: `${stat.dev}:${stat.ino}`,
        content: stat.isSymbolicLink()
          ? fs.readlinkSync(file)
          : stat.isFile()
            ? fs.readFileSync(file)
            : null,
      };
    });
}

function captureFailure(operation: () => void): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

function corruptByte(offset: number) {
  const before = fs.statSync(databasePath);
  const bytes = fs.readFileSync(databasePath);
  expect(offset).toBeGreaterThanOrEqual(0);
  expect(bytes[offset]).not.toBe(0xff);
  const file = fs.openSync(databasePath, "r+");
  try {
    fs.writeSync(file, Buffer.of(0xff), 0, 1, offset);
  } finally {
    fs.closeSync(file);
  }
  const after = fs.statSync(databasePath);
  expect([after.dev, after.ino, after.size]).toEqual([before.dev, before.ino, before.size]);
  // No SQLite change counter or schema cookie can invalidate the retained cache.
  const corrupted = fs.readFileSync(databasePath);
  expect(corrupted.subarray(24, 28)).toEqual(bytes.subarray(24, 28));
  expect(corrupted.subarray(40, 44)).toEqual(bytes.subarray(40, 44));
  expect(corrupted.subarray(92, 100)).toEqual(bytes.subarray(92, 100));
}

describe("invocation-scoped update ownership reader", () => {
  it("keeps native setup bounded across hundreds of real fences without excluding another writer", async () => {
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root);
      const retained = opened.filter((database) => database.isOpen);
      expect(retained).toHaveLength(1);
      const [reader] = retained;
      assert(reader);
      const admittedOpens = opened.length;
      const before = snapshot();
      for (let batch = 0; batch < 4; batch++) {
        for (let index = 0; index < 128; index++) {
          fence.assertCurrent();
        }
        // A retained connection must not retain an idle read transaction or lock.
        write((database) => database.exec("BEGIN EXCLUSIVE; COMMIT"));
        expect(reader.isTransaction).toBe(false);
        expect(reader.prepare("PRAGMA writable_schema").get()?.writable_schema).toBe(0);
      }
      expect(snapshot()).toEqual(before);
      expect(opened).toHaveLength(admittedOpens);
      // Fresh row reads share native preparation, not their result or authority.
      const preparations = leasePreparations.filter((database) => database === reader).length;
      expect(preparations).toBeGreaterThan(0);
      expect(preparations).toBeLessThanOrEqual(2);
    });
    write((database) => {
      expect(database.prepare("SELECT count(*) AS n FROM managed_update_handoffs").get()?.n).toBe(
        0,
      );
    });
  });

  it.each([false, true])(
    "disposes a real delegated reader before its child process exits (callback failure: %s)",
    async (rejects) => {
      const moduleUrl = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor).href;
      const program = `
        import assert from "node:assert/strict";
        import fs from "node:fs";
        import {createRequire} from "node:module";
        const input = JSON.parse(fs.readFileSync(0, "utf8"));
        assert.equal(fs.realpathSync(input.grant.databasePath), input.databasePath);
        const sqlite = createRequire(import.meta.url)("node:sqlite");
        const NativeDatabase = sqlite.DatabaseSync;
        const databases = [];
        sqlite.DatabaseSync = class extends NativeDatabase {
          constructor(...args) {
            super(...args);
            if (String(args[0]).includes("managed-update-handoffs.sqlite")) databases.push(this);
          }
        };
        const {withDelegatedUpdateCommandExecutor} = await import(${JSON.stringify(moduleUrl)});
        let observed = false;
        let failed = false;
        try {
          await withDelegatedUpdateCommandExecutor(input.grant, input.grant.runId, input.root, async (fence) => {
            for (let index = 0; index < 8; index++) fence.assertCurrent();
            assert.equal(databases.filter(database => database.isOpen).length, 1);
            observed = true;
            if (input.rejects) throw new Error("delegated callback rejected");
          });
        } catch(error) {
          assert.equal(error.message, "delegated callback rejected");
          failed = true;
        } finally {
          sqlite.DatabaseSync = NativeDatabase;
        }
        assert.equal(observed, true);
        assert.equal(failed, input.rejects);
        assert.equal(databases.every(database => !database.isOpen), true);
        process.stdout.write(JSON.stringify({closed: true, failed}));
      `;
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(root);
        const result = await withUpdateCommandExecutorChild(fence, root, (grant, beforeInput) =>
          runUtf8CommandWithTimeout(
            [
              process.execPath,
              "--import",
              pathToFileURL(path.resolve("scripts/tsx.mjs")).href,
              "--input-type=module",
              "--eval",
              program,
            ],
            {
              input: JSON.stringify({ grant, databasePath, root, rejects }),
              beforeInput,
              env: { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state") },
              timeoutMs: 15000,
              killProcessTree: true,
              requireProcessTreeExtinction: true,
            },
          ),
        );
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ closed: true, failed: rejects });
        fence.assertCurrent();
      });
    },
  );

  it.each(["owner", "payload", "generation", "deleted"] as const)(
    "observes committed %s revocation on the next fence",
    async (change) => {
      let before: ReturnType<typeof snapshot> | undefined;
      let refusal: unknown;
      await expect(
        withUpdateCommandExecutor(randomUUID(), async (executor) => {
          const fence = await executor.enter(root);
          fence.assertCurrent();
          write((database) => {
            const sql = {
              owner: "UPDATE managed_update_handoffs SET owner='replacement' WHERE install_root=?",
              payload: "UPDATE managed_update_handoffs SET payload_json='{}' WHERE install_root=?",
              generation:
                "UPDATE managed_update_handoffs SET updated_at=updated_at+1 WHERE install_root=?",
              deleted: "DELETE FROM managed_update_handoffs WHERE install_root=?",
            }[change];
            expect(database.prepare(sql).run(root).changes).toBe(1);
          });
          before = snapshot();
          refusal = captureFailure(fence.assertCurrent);
        }),
      ).rejects.toThrow();
      expect(refusal).toBeInstanceOf(UpdateCommandRecoveryPendingError);
      expect(before).toBeDefined();
      expect(snapshot()).toEqual(before);
    },
  );

  it.each(["callback failure", "preflight handoff"] as const)(
    "disposes its reader on %s and releases the original lease",
    async (ending) => {
      const failure = new Error("candidate rejected");
      const result = withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(root, { preflight: true });
        expect(opened.some((database) => database.isOpen)).toBe(true);
        if (ending === "callback failure") {
          throw failure;
        }
        releaseUpdateCommandPreflightForHandoff(fence);
        expect(opened.every((database) => !database.isOpen)).toBe(true);
        expect(() => fence.assertCurrent()).toThrow();
      });
      if (ending === "callback failure") {
        await expect(result).rejects.toBe(failure);
      } else {
        await result;
      }
      write((database) => {
        expect(database.prepare("SELECT count(*) AS n FROM managed_update_handoffs").get()?.n).toBe(
          0,
        );
      });
    },
  );

  it("closes its reader when physical authority changes during executor admission", async () => {
    const observeOpen = vi.mocked(nodeSqlite.openNodeSqliteDatabase).getMockImplementation()!;
    let reads = 0;
    let before: ReturnType<typeof snapshot> | undefined;
    vi.mocked(nodeSqlite.openNodeSqliteDatabase).mockImplementation((location, options) => {
      const database = observeOpen(location, options);
      if (options?.readOnly && ++reads === 2) {
        // The first read precedes the physical pin; the second belongs to the
        // newly pinned invocation reader and must not survive failed admission.
        // Adding a hard link changes physical authority on Windows too, where
        // SQLite's open handle prevents renaming or replacing the database.
        fs.linkSync(databasePath, path.join(root, "linked.sqlite"));
        before = snapshot();
      }
      return database;
    });
    let entered = false;
    await expect(
      withUpdateCommandExecutor(randomUUID(), async (executor) => {
        await executor.enter(root);
        entered = true;
      }),
    ).rejects.toThrow();
    expect(entered).toBe(false);
    expect(before).toBeDefined();
    expect(snapshot()).toEqual(before);
  });

  it("does not reuse a live row as proof of a changed process identity", async () => {
    let refusal: unknown;
    await expect(
      withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(root);
        const start = pidAlive.getFileLockProcessStartTime(process.pid);
        expect(start).not.toBeNull();
        const original = pidAlive.getFileLockProcessStartTime;
        vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockImplementation((pid, ...args) =>
          pid === process.pid ? start! + 1 : original(pid, ...args),
        );
        const before = snapshot();
        const observed = captureFailure(fence.assertCurrent);
        expect(snapshot()).toEqual(before);
        refusal = observed;
      }),
    ).rejects.toThrow();
    expect(refusal).toBeInstanceOf(UpdateCommandRecoveryPendingError);
    // A mismatched start identity proves the old generation dead to the existing
    // release owner. Refusing its fence must not disable that normal reclamation.
    write((database) => {
      expect(database.prepare("SELECT count(*) AS n FROM managed_update_handoffs").get()?.n).toBe(
        0,
      );
    });
  });

  const damage = [
    {
      name: "missing database",
      windowsSharingError: "EBUSY",
      apply: () => fs.renameSync(databasePath, path.join(root, "retained.sqlite")),
    },
    { name: "empty database", apply: () => fs.truncateSync(databasePath, 0) },
    { name: "corrupt database", apply: () => fs.writeFileSync(databasePath, "invalid SQLite") },
    { name: "in-place signature corruption", apply: () => corruptByte(0) },
    {
      name: "in-place lease-page corruption",
      apply: () => {
        let page = 0;
        write((database) => {
          page = Number(
            database
              .prepare("SELECT rootpage FROM sqlite_schema WHERE name='managed_update_handoffs'")
              .get()?.rootpage,
          );
        });
        const pageSize = fs.readFileSync(databasePath).readUInt16BE(16);
        expect(page).toBeGreaterThan(1);
        corruptByte((page - 1) * (pageSize === 1 ? 65536 : pageSize));
      },
    },
    {
      name: "in-place schema corruption",
      apply: () => {
        let sql = "";
        write((database) => {
          sql = String(
            database
              .prepare("SELECT sql FROM sqlite_schema WHERE name='managed_update_handoffs'")
              .get()?.sql,
          );
        });
        expect(sql).toMatch(/^create table/i);
        corruptByte(fs.readFileSync(databasePath).indexOf(sql));
      },
    },
    {
      name: "replacement database",
      windowsSharingError: "EPERM",
      apply: () => {
        const replacement = path.join(directory, "replacement.sqlite");
        fs.copyFileSync(databasePath, replacement);
        fs.chmodSync(replacement, 0o600);
        try {
          fs.renameSync(replacement, databasePath);
        } finally {
          fs.rmSync(replacement, { force: true });
        }
      },
    },
    {
      name: "replacement parent retaining the database inode",
      windowsSharingError: "EPERM",
      apply: () => {
        const retained = path.join(root, "retained-parent");
        fs.renameSync(directory, retained);
        fs.mkdirSync(directory, { mode: 0o700 });
        fs.renameSync(path.join(retained, path.basename(databasePath)), databasePath);
      },
    },
    {
      name: "multiply linked database",
      apply: () => fs.linkSync(databasePath, path.join(root, "linked.sqlite")),
    },
    {
      name: "changed schema",
      apply: () => write((database) => database.exec("DROP TABLE managed_update_handoffs")),
    },
    {
      name: "WAL transition",
      apply: () => {
        write((database) => {
          expect(database.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode).toBe("wal");
        });
        expect(fs.readdirSync(directory)).toEqual([path.basename(databasePath)]);
      },
    },
  ];

  it.each(damage)(
    "preserves authority for $name after warming the reader without repair or sidecars",
    async ({ apply, windowsSharingError }) => {
      let before: ReturnType<typeof snapshot> | undefined;
      let refusal: unknown;
      let nativeDenial = false;
      const failure = await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(root);
        for (let i = 0; i < 3; i++) {
          fence.assertCurrent();
        }
        const intact = snapshot();
        const mutationError = captureFailure(apply);
        if (mutationError) {
          // Native Windows SQLite handles deny path replacement. Prove the
          // attempted mutation was refused and the original authority still
          // works; platforms permitting replacement must reject its fence.
          expect(process.platform).toBe("win32");
          expect(windowsSharingError).toBeDefined();
          expect(mutationError).toMatchObject({ code: windowsSharingError });
          expect(snapshot()).toEqual(intact);
          fence.assertCurrent();
          nativeDenial = true;
          return;
        }
        before = snapshot();
        refusal = captureFailure(fence.assertCurrent);
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      if (nativeDenial) {
        expect(failure).toBeUndefined();
        return;
      }
      if (refusal === undefined) {
        // Fixture assertions inside executor settlement must keep their original
        // diagnostic instead of becoming a misleading missing-fence assertion.
        throw failure;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(refusal).toBeInstanceOf(UpdateCommandRecoveryPendingError);
      expect(before).toBeDefined();
      expect(snapshot()).toEqual(before);
    },
  );

  it.skipIf(process.platform === "win32").each(["database", "parent"] as const)(
    "refuses unsafe %s permissions without repairing them",
    async (target) => {
      let before: ReturnType<typeof snapshot> | undefined;
      let refusal: unknown;
      await expect(
        withUpdateCommandExecutor(randomUUID(), async (executor) => {
          const fence = await executor.enter(root);
          fs.chmodSync(
            target === "database" ? databasePath : directory,
            target === "database" ? 0o640 : 0o750,
          );
          before = snapshot();
          refusal = captureFailure(fence.assertCurrent);
        }),
      ).rejects.toThrow();
      expect(refusal).toBeInstanceOf(UpdateCommandRecoveryPendingError);
      expect(snapshot()).toEqual(before);
    },
  );

  it.skipIf(process.platform === "win32").each(["database", "parent"] as const)(
    "refuses a symlinked %s even when it reaches the original inode",
    async (target) => {
      let before: ReturnType<typeof snapshot> | undefined;
      let refusal: unknown;
      await expect(
        withUpdateCommandExecutor(randomUUID(), async (executor) => {
          const fence = await executor.enter(root);
          const source = target === "database" ? databasePath : directory;
          const retained = path.join(
            root,
            target === "database" ? "retained.sqlite" : "retained-parent",
          );
          fs.renameSync(source, retained);
          fs.symlinkSync(retained, source, target === "database" ? "file" : "dir");
          before = snapshot();
          refusal = captureFailure(fence.assertCurrent);
        }),
      ).rejects.toThrow();
      expect(refusal).toBeInstanceOf(UpdateCommandRecoveryPendingError);
      expect(snapshot()).toEqual(before);
    },
  );

  it("refuses a hot journal after warming the reader and preserves its recovery bytes", async () => {
    let before: ReturnType<typeof snapshot> | undefined;
    let refusal: unknown;
    await expect(
      withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(root);
        write((database) =>
          database.exec(`
        CREATE TABLE padding(data BLOB);
        WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<32)
        INSERT INTO padding SELECT zeroblob(8192) FROM n;
      `),
        );
        fence.assertCurrent();
        const crashed = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            `
        import { DatabaseSync } from 'node:sqlite';
        const database = new DatabaseSync(process.argv[1]);
        database.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA cache_size=2; PRAGMA cache_spill=ON; BEGIN IMMEDIATE; UPDATE managed_update_handoffs SET owner='uncommitted'; UPDATE padding SET data=zeroblob(16384)");
        process.exit(0);
      `,
            databasePath,
          ],
          { encoding: "utf8", env: {}, timeout: 5000 },
        );
        expect(crashed.error).toBeUndefined();
        expect(crashed.status, crashed.stderr).toBe(0);
        expect(fs.statSync(databasePath + "-journal").size).toBeGreaterThan(512);
        before = snapshot();
        refusal = captureFailure(fence.assertCurrent);
      }),
    ).rejects.toThrow();
    expect(refusal).toBeInstanceOf(UpdateCommandRecoveryPendingError);
    expect(before).toBeDefined();
    expect(snapshot()).toEqual(before);
  });
});
