import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import { stateNativeProcessEntrypoints } from "../state/native-process-runtime.test-support.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import {
  acquireGatewayStateOwner,
  acquireStateDatabaseSchemaLease,
  assertStateDatabaseAccessAllowed,
  GatewayStateOwnerContentionError,
  hasActiveGatewayStateOwner,
  resolveGatewayStateOwnerPath,
  tryAcquireGatewayStateOwner,
  tryBorrowGatewayStateOwner,
  withStateDatabaseColdAdmission,
} from "./gateway-state-owner.js";
import * as nodeSqlite from "./node-sqlite.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

describe("Gateway state ownership", () => {
  it.skipIf(process.platform === "win32")(
    "acquires Gateway ownership on healthy state storage when system tmp is exhausted",
    async () => {
      await withTempDir("openclaw-owner-tmp-pressure-", async (root) => {
        const systemTmp = fs.realpathSync("/tmp");
        const open = fs.openSync.bind(fs);
        const pressure = vi.spyOn(fs, "openSync").mockImplementation((pathname, flags, mode) => {
          if (
            typeof pathname === "string" &&
            path.dirname(path.dirname(pathname)) === systemTmp &&
            path.basename(path.dirname(pathname)).startsWith("openclaw-state-owners") &&
            typeof flags === "number" &&
            (flags & fs.constants.O_CREAT) !== 0
          ) {
            throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
          }
          return open(pathname, flags, mode);
        });
        let owner: Awaited<ReturnType<typeof acquireGatewayLock>> = null;
        try {
          owner = await acquireGatewayLock({
            allowInTests: true,
            env: { OPENCLAW_STATE_DIR: root },
            timeoutMs: 0,
          });
          if (!owner) {
            throw new Error("Expected Gateway ownership");
          }
          owner.assertCurrent();
          expect(path.relative(fs.realpathSync(root), owner.lockPath)).not.toMatch(/^\.\./u);
          expect(
            tryAcquireGatewayStateOwner(path.join(root, "state", "openclaw.sqlite")),
          ).toBeNull();
        } finally {
          await owner?.release();
          pressure.mockRestore();
        }
      });
    },
  );

  it.skipIf(process.platform === "win32").each(["process", "schema"] as const)(
    "recovers a removed empty parent before %s ownership without replaying protected work",
    async (kind) => {
      await withTempDir("openclaw-owner-parent-race-", async (root) => {
        const stateDir = path.join(fs.realpathSync(root), "absent");
        const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
        const pathname = resolveGatewayStateOwnerPath(databasePath);
        const open = fs.openSync.bind(fs);
        let removed = false;
        const admission = vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
          if (
            file === pathname &&
            typeof flags === "number" &&
            (flags & fs.constants.O_CREAT) !== 0 &&
            !removed
          ) {
            fs.rmdirSync(path.dirname(pathname));
            removed = true;
          }
          return open(file, flags, mode);
        });
        let owner: ReturnType<typeof acquireGatewayStateOwner> | undefined;
        try {
          owner =
            kind === "schema"
              ? acquireStateDatabaseSchemaLease(databasePath)
              : acquireGatewayStateOwner({ databasePath });
          expect(removed).toBe(true);
          const operation = vi.fn(() => assertStateDatabaseAccessAllowed(databasePath));
          owner.run(operation);
          expect(operation).toHaveBeenCalledOnce();
          expect(tryAcquireGatewayStateOwner(databasePath)).toBeNull();
        } finally {
          admission.mockRestore();
          owner?.release();
        }
        expect(fs.existsSync(pathname)).toBe(false);
        if (kind === "schema") {
          expect(fs.existsSync(stateDir)).toBe(false);
        }
      });
    },
  );

  it.each([
    "already held",
    "after native open",
    "replaced by maintenance",
    "empty publication",
    "partial publication",
    "publication becomes maintenance",
  ] as const)(
    "joins a transient schema owner for a created but uninitialized database: %s",
    async (arrival) => {
      await withTempDir("openclaw-cold-schema-owner-", async (root) => {
        const databasePath = path.join(root, "openclaw.sqlite");
        fs.writeFileSync(databasePath, "");
        const databaseLocation = path.toNamespacedPath(fs.realpathSync(databasePath));
        const seed = acquireGatewayStateOwner({ databasePath });
        const marker = seed.path;
        seed.release();
        const payload = {
          pid: process.ppid,
          ownerId: "foreign-schema-fixture",
          createdAt: new Date().toISOString(),
          configPath: path.join(root, "openclaw.json"),
          role: "sqlite-maintenance",
          stateOwnerKind: "schema",
        };
        const publishMarker = () => fs.writeFileSync(marker, JSON.stringify(payload));
        const publishing =
          arrival === "empty publication" ||
          arrival === "partial publication" ||
          arrival === "publication becomes maintenance";
        const becomesMaintenance =
          arrival === "replaced by maintenance" || arrival === "publication becomes maintenance";
        const native = nodeSqlite.openNodeSqliteDatabase;
        let intercepted = false;
        const open = vi
          .spyOn(nodeSqlite, "openNodeSqliteDatabase")
          .mockImplementation((...args) => {
            const database = native(...args);
            const location = database.location();
            if (
              arrival === "after native open" &&
              location !== null &&
              path.toNamespacedPath(location) === databaseLocation &&
              !intercepted
            ) {
              intercepted = true;
              publishMarker();
            }
            return database;
          });
        if (publishing) {
          fs.writeFileSync(marker, arrival === "empty publication" ? "" : '{"pid":');
        } else if (arrival !== "after native open") {
          publishMarker();
        }
        let waits = 0;
        const wait = vi.spyOn(Atomics, "wait").mockImplementation(() => {
          waits += 1;
          expect(fs.statSync(databasePath).size).toBe(0);
          if (becomesMaintenance) {
            const { stateOwnerKind: _schema, ...maintenance } = payload;
            fs.writeFileSync(marker, JSON.stringify(maintenance));
          } else if (publishing && waits === 1) {
            publishMarker();
          } else {
            fs.unlinkSync(marker);
          }
          return "ok";
        });
        try {
          if (becomesMaintenance) {
            expect(() => openOpenClawStateDatabase({ path: databasePath })).toThrow(
              "offline maintenance",
            );
            expect(fs.statSync(databasePath).size).toBe(0);
          } else {
            const database = openOpenClawStateDatabase({ path: databasePath });
            expect(
              database.db.prepare("SELECT role FROM schema_meta WHERE meta_key = 'primary'").get(),
            ).toEqual({ role: "global" });
            expect(database.db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5_000);
          }
          expect(wait).toHaveBeenCalledTimes(publishing && !becomesMaintenance ? 2 : 1);
        } finally {
          wait.mockRestore();
          open.mockRestore();
          fs.rmSync(marker, { force: true });
          closeOpenClawStateDatabaseForTest();
        }
      });
    },
  );

  it.each(["schema owners", "incomplete publication", "persistent malformed publication"] as const)(
    "keeps one cold-open budget across %s and never waits on its own PID",
    async (observation) => {
      await withTempDir("openclaw-cold-schema-budget-", async (root) => {
        const databasePath = path.join(root, "openclaw.sqlite");
        const seed = acquireGatewayStateOwner({ databasePath });
        const marker = seed.path;
        seed.release();
        let owner = 0;
        const publish = (pid: number) =>
          fs.writeFileSync(
            marker,
            JSON.stringify({
              pid,
              ownerId: `schema-fixture-${owner++}`,
              createdAt: new Date().toISOString(),
              configPath: path.join(root, "openclaw.json"),
              role: "sqlite-maintenance",
              stateOwnerKind: "schema",
            }),
          );
        let now = 0;
        const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
        const wait = vi
          .spyOn(Atomics, "wait")
          .mockImplementation((_array, _index, _value, timeout) => {
            now += timeout ?? 0;
            if (observation !== "persistent malformed publication") {
              publish(process.ppid);
            }
            return "timed-out";
          });
        const open = vi.fn();
        try {
          if (observation === "schema owners") {
            publish(process.ppid);
          } else {
            fs.writeFileSync(marker, '{"pid":');
          }
          expect(() =>
            withStateDatabaseColdAdmission({ databasePath, busyTimeoutMs: 25 }, open),
          ).toThrow(
            observation === "persistent malformed publication"
              ? "could not be verified"
              : "offline maintenance",
          );
          expect(now).toBe(25);
          expect(open).not.toHaveBeenCalled();
          wait.mockClear();
          publish(process.pid);
          expect(() =>
            withStateDatabaseColdAdmission({ databasePath, busyTimeoutMs: 25 }, open),
          ).toThrow("offline maintenance");
          expect(wait).not.toHaveBeenCalled();
          expect(open).not.toHaveBeenCalled();
        } finally {
          clock.mockRestore();
          wait.mockRestore();
          fs.rmSync(marker, { force: true });
        }
      });
    },
  );

  it("explains contention while preserving the database path and native cause", () => {
    const databasePath = "/synthetic/openclaw.sqlite";
    const cause = new Error("synthetic native lock contention");
    const error = new GatewayStateOwnerContentionError(databasePath, cause);
    expect(error.databasePath).toBe(databasePath);
    expect(error.cause).toBe(cause);
    expect(error.message).toContain(`OpenClaw state database is busy at ${databasePath}.`);
    expect(error.message).toContain("Wait for the other OpenClaw process to finish, then retry.");
    expect(error.message).toContain(
      "If it persists, run `openclaw gateway status` and check for other OpenClaw processes using the same state directory.",
    );
    expect(error.message).toContain(
      "A running Gateway can hold this ownership until it stops; stop it through its service manager or original terminal before retrying.",
    );
  });

  it.each(["schema", "nested maintenance"])(
    "retains accepted %s after the root stops lending",
    async (kind) => {
      await withTempDir("openclaw-state-owner-", async (root) => {
        const databasePath = path.join(root, "state", "openclaw.sqlite");
        const owner = acquireGatewayStateOwner({
          databasePath,
          payload: {
            pid: process.pid,
            createdAt: new Date().toISOString(),
            configPath: path.join(root, "openclaw.json"),
            role: "gateway",
          },
        });
        const accepted =
          kind === "schema"
            ? acquireStateDatabaseSchemaLease(databasePath)
            : tryBorrowGatewayStateOwner(databasePath);
        if (!accepted) {
          owner.release();
          throw new Error("Expected retained process ownership");
        }
        const projectionPath = path.join(resolveGatewayLockDir(root), "gateway.state.lock");
        try {
          assertStateDatabaseAccessAllowed(databasePath);
          expect(tryAcquireGatewayStateOwner(databasePath)).toBeNull();
          expect(hasActiveGatewayStateOwner(databasePath)).toBe(true);
          owner.release();
          expect(hasActiveGatewayStateOwner(databasePath)).toBe(false);
          expect(() => owner.assertCurrent()).toThrow("no longer current");
          accepted.assertCurrent();
          accepted.assertDatabaseAccess(databasePath);
          expect(() => assertStateDatabaseAccessAllowed(databasePath)).toThrow();
          accepted.run(() => assertStateDatabaseAccessAllowed(databasePath));
          expect(fs.existsSync(owner.path)).toBe(true);
          expect(fs.existsSync(projectionPath)).toBe(true);
          expect(() => acquireStateDatabaseSchemaLease(databasePath)).toThrow(
            GatewayStateOwnerContentionError,
          );
        } finally {
          owner.release();
          accepted.release();
        }
        expect(fs.existsSync(resolveGatewayStateOwnerPath(databasePath))).toBe(false);
        expect(fs.existsSync(projectionPath)).toBe(false);
        expect(fs.existsSync(databasePath)).toBe(false);
        const next = acquireGatewayStateOwner({ databasePath });
        next.release();
        expect(fs.existsSync(next.path)).toBe(false);
      });
    },
  );

  it("retains the Gateway's exact projection through root release and retries failed cleanup", async () => {
    await withTempDir("openclaw-schema-projection-", async (root) => {
      const databasePath = path.join(root, "state", "openclaw.sqlite");
      const gateway = await acquireGatewayLock({
        allowInTests: true,
        timeoutMs: 0,
        env: { OPENCLAW_STATE_DIR: root },
        lockDir: path.join(root, "custom-locks"),
      });
      if (!gateway) {
        throw new Error("Expected Gateway ownership");
      }
      const schema = acquireStateDatabaseSchemaLease(databasePath);
      const projection = fs.readFileSync(gateway.stateLockPath);
      try {
        await gateway.release();
        schema.assertCurrent();
        expect(fs.readFileSync(gateway.stateLockPath)).toEqual(projection);
        expect(fs.existsSync(path.join(resolveGatewayLockDir(root), "gateway.state.lock"))).toBe(
          false,
        );
        const rm = fs.rmSync.bind(fs);
        const failure = new Error("controlled projection cleanup failure");
        const remove = vi.spyOn(fs, "rmSync").mockImplementation((pathname, options) => {
          if (pathname === gateway.stateLockPath) {
            throw failure;
          }
          rm(pathname, options);
        });
        try {
          expect(() => schema.release()).toThrow(failure);
          expect(fs.existsSync(gateway.lockPath)).toBe(true);
          expect(fs.existsSync(gateway.stateLockPath)).toBe(true);
          expect(tryAcquireGatewayStateOwner(databasePath)).toBeNull();
        } finally {
          remove.mockRestore();
        }
        schema.release();
        expect(fs.existsSync(gateway.lockPath)).toBe(false);
        expect(fs.existsSync(gateway.stateLockPath)).toBe(false);
      } finally {
        await gateway.release();
        schema.release();
      }
    });
  });

  it("refuses replaced schema projections without deleting the competing marker", async () => {
    await withTempDir("openclaw-schema-replaced-projection-", async (root) => {
      const databasePath = path.join(root, "state", "openclaw.sqlite");
      const lease = acquireStateDatabaseSchemaLease(databasePath);
      const projectionPath = path.join(resolveGatewayLockDir(root), "gateway.state.lock");
      try {
        lease.run(() => {
          fs.writeFileSync(projectionPath, "replacement");
          expect(() => lease.assertCurrent()).toThrow("no longer current");
          expect(() => acquireStateDatabaseSchemaLease(databasePath)).toThrow("no longer current");
        });
      } finally {
        lease.release();
      }
      expect(fs.readFileSync(projectionPath, "utf8")).toBe("replacement");
      expect(fs.existsSync(lease.path)).toBe(false);
    });
  });

  it("keeps a standalone schema operation exclusive without creating a coordinator database", async () => {
    await withTempDir("openclaw-schema-owner-", async (root) => {
      const databasePath = path.join(root, "state", "openclaw.sqlite");
      const schema = acquireStateDatabaseSchemaLease(databasePath);
      try {
        schema.assertCurrent();
        expect(hasActiveGatewayStateOwner(databasePath)).toBe(false);
        expect(tryAcquireGatewayStateOwner(databasePath)).toBeNull();
        expect(fs.existsSync(`${schema.path}.sqlite`)).toBe(false);
        expect(fs.existsSync(databasePath)).toBe(false);
        expect(
          JSON.parse(
            fs.readFileSync(path.join(resolveGatewayLockDir(root), "gateway.state.lock"), "utf8"),
          ),
        ).toMatchObject({ role: "agent-embedded" });
      } finally {
        schema.release();
      }
      expect(fs.existsSync(schema.path)).toBe(false);
    });
  });

  it("blocks a foreign ordinary writer while a standalone schema lease owns state", async () => {
    await withTempDir("openclaw-schema-foreign-write-", async (root) => {
      const options = { env: { OPENCLAW_STATE_DIR: root } };
      const databasePath = openOpenClawStateDatabase(options).path;
      closeOpenClawStateDatabaseForTest();
      const schema = acquireStateDatabaseSchemaLease(databasePath);
      try {
        schema.run(() =>
          runOpenClawStateWriteTransaction(({ db }) => {
            db.prepare(
              "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
            ).run("schema-owner-proof", "true", 1);
          }, options),
        );
        const stateUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.stateDatabase);
        const child = await runNodeScript(
          [
            ...resolveRuntimeWorkerArgv(stateUrl).slice(0, -1),
            "--input-type=module",
            "--eval",
            `import { runOpenClawStateWriteTransaction, closeOpenClawStateDatabaseForTest } from ${JSON.stringify(stateUrl.href)};
          try {
            runOpenClawStateWriteTransaction(({ db }) => {
              db.prepare("INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)").run("foreign-schema-intrusion", "true", 2);
            });
            process.stdout.write(JSON.stringify({ committed: true }));
          } catch (error) {
            process.stdout.write(JSON.stringify({ refused: error.message }));
          } finally {
            closeOpenClawStateDatabaseForTest();
          }`,
          ],
          { ...process.env, OPENCLAW_STATE_DIR: root },
          30_000,
        );
        expect(child.status).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual({
          refused: expect.stringContaining("offline maintenance"),
        });
        expect(JSON.parse(fs.readFileSync(schema.path, "utf8"))).toMatchObject({
          role: "sqlite-maintenance",
        });
        expect(
          JSON.parse(
            fs.readFileSync(path.join(resolveGatewayLockDir(root), "gateway.state.lock"), "utf8"),
          ),
        ).toMatchObject({
          role: "agent-embedded",
        });
        expect(() => openOpenClawStateDatabase(options)).toThrow("offline maintenance");
        schema.run(() => {
          expect(
            openOpenClawStateDatabase(options)
              .db.prepare(
                "SELECT state_key FROM config_machine_state WHERE state_key IN ('schema-owner-proof', 'foreign-schema-intrusion') ORDER BY state_key",
              )
              .all(),
          ).toEqual([{ state_key: "schema-owner-proof" }]);
        });
      } finally {
        schema.run(() => closeOpenClawStateDatabaseForTest());
        schema.release();
      }
      expect(() => openOpenClawStateDatabase(options)).not.toThrow();
      closeOpenClawStateDatabaseForTest();
    });
  });

  it("shares actual transient schema custody until the final same-process borrower settles", async () => {
    await withTempDir("openclaw-shared-schema-owner-", async (root) => {
      const stateDir = path.join(root, "absent");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      const first = acquireStateDatabaseSchemaLease(databasePath);
      const second = first.run(() => acquireStateDatabaseSchemaLease(databasePath));
      first.release();
      try {
        second.assertCurrent();
        expect(
          fs.existsSync(path.join(resolveGatewayLockDir(stateDir), "gateway.state.lock")),
        ).toBe(true);
        expect(fs.existsSync(second.path)).toBe(true);
        expect(hasActiveGatewayStateOwner(databasePath)).toBe(false);
        const third = second.run(() => acquireStateDatabaseSchemaLease(databasePath));
        third.release();
        expect(tryAcquireGatewayStateOwner(databasePath)).toBeNull();
      } finally {
        second.release();
      }
      expect(fs.existsSync(first.path)).toBe(false);
      expect(fs.existsSync(stateDir)).toBe(false);
      expect(fs.existsSync(root)).toBe(true);
      acquireGatewayStateOwner({ databasePath }).release();
    });
  });

  it("retries owned-directory cleanup after releasing the final physical lock", async () => {
    await withTempDir("openclaw-schema-directory-cleanup-", async (root) => {
      const stateDir = path.join(fs.realpathSync(root), "absent");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      const lease = acquireStateDatabaseSchemaLease(databasePath);
      const directory = resolveGatewayLockDir(stateDir);
      const rmdir = fs.rmdirSync.bind(fs);
      const failure = new Error("controlled directory cleanup failure");
      const remove = vi.spyOn(fs, "rmdirSync").mockImplementation((pathname) => {
        if (pathname === directory) {
          throw failure;
        }
        rmdir(pathname);
      });
      try {
        expect(() => lease.release()).toThrow(failure);
        expect(fs.existsSync(lease.path)).toBe(false);
        expect(fs.existsSync(path.join(directory, "gateway.state.lock"))).toBe(false);
        expect(fs.existsSync(directory)).toBe(true);
      } finally {
        remove.mockRestore();
        lease.release();
      }
      expect(fs.existsSync(stateDir)).toBe(false);
      expect(fs.existsSync(root)).toBe(true);
    });
  });

  it.each(["published", "replaced"])(
    "preserves %s projection directories during cleanup",
    async (kind) => {
      await withTempDir("openclaw-schema-directory-preservation-", async (root) => {
        const stateDir = path.join(fs.realpathSync(root), "absent");
        const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
        const lease = acquireStateDatabaseSchemaLease(databasePath);
        const directory = resolveGatewayLockDir(stateDir);
        const sentinel = path.join(directory, "published.txt");
        if (kind === "published") {
          fs.writeFileSync(sentinel, "published");
        }
        const remove = fs.rmSync.bind(fs);
        const replacement =
          kind === "replaced"
            ? vi.spyOn(fs, "rmSync").mockImplementation((pathname, options) => {
                remove(pathname, options);
                if (pathname === path.join(directory, "gateway.state.lock")) {
                  fs.renameSync(directory, directory + ".original");
                  fs.mkdirSync(directory);
                }
              })
            : undefined;
        try {
          lease.release();
          expect(fs.existsSync(directory)).toBe(true);
          if (kind === "published") {
            expect(fs.readFileSync(sentinel, "utf8")).toBe("published");
          } else {
            expect(fs.readdirSync(directory)).toEqual([]);
          }
        } finally {
          replacement?.mockRestore();
          lease.release();
        }
      });
    },
  );

  it("refuses new schema loans when the retained owner's sidecar has changed", async () => {
    await withTempDir("openclaw-state-owner-replaced-", async (root) => {
      const databasePath = path.join(root, "state", "openclaw.sqlite");
      const owner = acquireGatewayStateOwner({ databasePath });
      const original = fs.readFileSync(owner.path);
      try {
        fs.writeFileSync(owner.path, "replacement");
        expect(() => owner.assertCurrent()).toThrow("no longer current");
        expect(() => assertStateDatabaseAccessAllowed(databasePath)).toThrow(
          "could not be verified",
        );
        expect(() => acquireStateDatabaseSchemaLease(databasePath)).toThrow(
          GatewayStateOwnerContentionError,
        );
      } finally {
        fs.writeFileSync(owner.path, original);
        owner.release();
      }
    });
  });

  it("allows ordinary access for serving owners and blocks foreign maintenance or malformed records", async () => {
    await withTempDir("openclaw-state-access-", async (root) => {
      const databasePath = path.join(root, "state", "openclaw.sqlite");
      const owner = acquireGatewayStateOwner({ databasePath });
      const pathname = owner.path;
      owner.release();
      const record = {
        pid: process.ppid,
        createdAt: new Date().toISOString(),
        configPath: path.join(root, "openclaw.json"),
      };
      try {
        for (const role of [undefined, "gateway", "agent-embedded"] as const) {
          fs.writeFileSync(pathname, JSON.stringify({ ...record, role }));
          expect(() => assertStateDatabaseAccessAllowed(databasePath)).not.toThrow();
        }
        for (const role of ["sqlite-maintenance", "skill-workshop-apply"] as const) {
          fs.writeFileSync(pathname, JSON.stringify({ ...record, role }));
          expect(() => assertStateDatabaseAccessAllowed(databasePath)).toThrow(
            "offline maintenance",
          );
        }
        for (const raw of ["{", JSON.stringify({ ...record, role: "unknown" })]) {
          fs.writeFileSync(pathname, raw);
          expect(() => assertStateDatabaseAccessAllowed(databasePath)).toThrow(
            "could not be verified",
          );
        }
      } finally {
        fs.rmSync(pathname, { force: true });
      }
      expect(() => assertStateDatabaseAccessAllowed(databasePath)).not.toThrow();
    });
  });

  it("refuses a matching-PID marker without live maintenance authority", async () => {
    await withTempDir("openclaw-state-worker-access-", async (root) => {
      const databasePath = path.join(root, "state", "openclaw.sqlite");
      const owner = acquireGatewayStateOwner({ databasePath });
      const original = fs.readFileSync(owner.path);
      owner.release();
      fs.writeFileSync(owner.path, original);
      try {
        expect(() => assertStateDatabaseAccessAllowed(databasePath)).toThrow("offline maintenance");
        expect(() => acquireStateDatabaseSchemaLease(databasePath)).toThrow(
          GatewayStateOwnerContentionError,
        );
      } finally {
        fs.rmSync(owner.path, { force: true });
      }
    });
  });

  it("ignores a definitely dead maintenance owner without reclaiming its sidecar", async () => {
    await withTempDir("openclaw-state-dead-owner-", async (root) => {
      const databasePath = path.join(root, "state", "openclaw.sqlite");
      const owner = acquireGatewayStateOwner({ databasePath });
      owner.release();
      const deadPid = process.pid + 1;
      const record = JSON.stringify({
        pid: deadPid,
        role: "sqlite-maintenance",
        createdAt: new Date().toISOString(),
        configPath: path.join(root, "openclaw.json"),
      });
      fs.writeFileSync(owner.path, record);
      const kill = process.kill.bind(process);
      const probe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === deadPid && signal === 0) {
          throw Object.assign(new Error("No such process"), { code: "ESRCH" });
        }
        return kill(pid, signal);
      });
      try {
        expect(() => assertStateDatabaseAccessAllowed(databasePath)).not.toThrow();
        expect(fs.readFileSync(owner.path, "utf8")).toBe(record);
      } finally {
        probe.mockRestore();
        fs.rmSync(owner.path, { force: true });
      }
    });
  });
});
