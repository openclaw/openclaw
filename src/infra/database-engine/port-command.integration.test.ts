import "./port-command-worker.test-support.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctorDatabasePort } from "../../commands/doctor-database-port.js";
import * as configIo from "../../config/io.js";
import * as pluginMetadata from "../../plugins/plugin-metadata-snapshot.js";
import { readBackupEngine } from "../../snapshot/database-backup.js";
import { assertOpenClawStateDatabaseForMaintenance } from "../../state/openclaw-state-db-maintenance.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { readClientCredentialReceipt } from "../client-credential-readiness.js";
import { readClientCredentialFileIdentity } from "../client-credential-receipt.js";
import { openClientCredentialCustody } from "../client-credential-store.js";
import * as recovery from "../database-port-recovery.js";
import * as disk from "../disk-space.js";
import { acquireGatewayLock } from "../gateway-lock.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../runtime-worker-url.js";
import * as snapshots from "../sqlite-snapshot.js";
import {
  canonical,
  canonicalPostgres,
  connection,
  expectSafe,
  files,
  fixture,
  injected,
  manifest,
  payload,
} from "./port-command.integration.test-support.js";
import * as tasks from "./port-command.worker.js";

afterEach(() => vi.restoreAllMocks());

function makeLegacy(file: string) {
  using db = openNodeSqliteDatabase(file);
  db.exec(
    "DELETE FROM workboard_schema_migrations; INSERT INTO workboard_schema_migrations VALUES ('schema-2', 17); ALTER TABLE workboard_boards DROP COLUMN automation_job_id; ALTER TABLE workboard_boards DROP COLUMN kind; ALTER TABLE workboard_boards DROP COLUMN sessions_spec; PRAGMA user_version = 2",
  );
}

function hash(file: string) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
async function loseOneCommittedReply(original: string) {
  const dropped = new Int32Array(new SharedArrayBuffer(4));
  const url = new URL("./port-command-proxy.test-support.ts", import.meta.url);
  const worker = new Worker(url, {
    execArgv: resolveRuntimeWorkerThreadExecArgv(url),
    workerData: { original, dropped },
  });
  const exited = new Promise<number>((resolve) => {
    worker.once("exit", resolve);
  });
  let proxyConnection: string;
  try {
    proxyConnection = await new Promise<string>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
  } catch (error) {
    await exited;
    throw error;
  }
  return {
    connection: proxyConnection,
    dropped: () => Atomics.load(dropped, 0),
    close: async () => {
      worker.postMessage("close", []);
      expect(await exited).toBe(0);
    },
  };
}

describe("database port command custody and inspection", () => {
  it.each(["canonical", "symlinked ancestor"])(
    "takes no persistent action for a dry run through a %s state path, including disabled workboard stores",
    async (statePath) => {
      await fixture(async ({ state, source }) => {
        if (statePath === "symlinked ancestor") {
          const homeAlias = state.path("home-alias");
          await fsp.symlink(state.home, homeAlias, "junction");
          state.envVars.OPENCLAW_STATE_DIR = path.join(homeAlias, ".openclaw");
          state.applyEnv();
        }
        const before = await files(state.stateDir);
        const hashes = before.map((file) => [file, hash(file)]);
        const result = await doctorDatabasePort({ to: "sqlite", dryRun: true });
        expect(result).toMatchObject({ phase: "preflight", stores: [source] });
        expect(await files(state.stateDir)).toEqual(before);
        expect(before.map((file) => [file, hash(file)])).toEqual(hashes);
        expect(JSON.stringify(result)).not.toContain(connection ?? injected);
        expect(JSON.stringify(result)).not.toContain(payload);
      });
    },
  );

  it("refuses an already hosted owner before touching config or stores", async () => {
    await fixture(async ({ state, source }) => {
      const original = hash(source);
      const owner = await acquireGatewayLock({
        env: state.env,
        role: "gateway",
        allowInTests: true,
        timeoutMs: 0,
      });
      assert(owner);
      try {
        const error = await doctorDatabasePort({ to: "postgres" }).catch(
          (failure: unknown) => failure,
        );
        expectSafe(error, state.stateDir, "preflight");
        expect(String(error)).toContain("hosted Gateway owner");
        expect(hash(source)).toBe(original);
        expect(fs.existsSync(recovery.databasePortManifestPath(state.stateDir))).toBe(false);
      } finally {
        await owner.release();
      }
    });
  });

  it("refuses foreign physical custody instead of dispatching or mutating", async () => {
    await fixture(async ({ state, source }) => {
      const original = hash(source);
      const url = new URL("./port-command-owner.test-support.ts", import.meta.url);
      const worker = new Worker(url, {
        execArgv: resolveRuntimeWorkerThreadExecArgv(url),
        workerData: { env: state.env },
      });
      const exited = new Promise<number>((resolve, reject) => {
        worker.once("error", reject);
        worker.once("exit", resolve);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          worker.once("message", () => resolve());
          worker.once("error", reject);
        });
        const error = await doctorDatabasePort({ to: "postgres" }).catch(
          (failure: unknown) => failure,
        );
        expectSafe(error, state.stateDir, "preflight");
        expect(hash(source)).toBe(original);
        expect(fs.existsSync(recovery.databasePortManifestPath(state.stateDir))).toBe(false);
      } finally {
        worker.postMessage("release", []);
        expect(await exited).toBe(0);
      }
    });
  });

  it("refuses insufficient local capacity before capture", async () => {
    await fixture(async ({ state, source }) => {
      const before = hash(source);
      vi.spyOn(disk, "tryReadDiskSpace").mockImplementation((targetPath) => ({
        targetPath,
        checkedPath: targetPath,
        availableBytes: 0,
        totalBytes: 1,
      }));
      const error = await doctorDatabasePort({ to: "sqlite", dryRun: true }).catch(
        (failure: unknown) => failure,
      );
      expectSafe(error, source, "preflight");
      expect(String(error)).toContain("0 bytes free");
      expect(hash(source)).toBe(before);
      expect(fs.existsSync(recovery.databasePortManifestPath(state.stateDir))).toBe(false);
    });
  });

  it("refuses aliased source paths without exposing database payloads", async () => {
    await fixture(async ({ state, source }) => {
      const alias = state.statePath("alias.sqlite");
      await fsp.link(source, alias);
      const original = hash(source);
      const error = await doctorDatabasePort({ to: "sqlite", dryRun: true }).catch(
        (failure: unknown) => failure,
      );
      expectSafe(error, source, "preflight");
      expect(hash(source)).toBe(original);
    });
  });
});

it("captures prefixed destination names and preserves them when rolling back before staging", async () => {
  await fixture(async ({ state, source }) => {
    const config = JSON.parse(fs.readFileSync(state.configPath, "utf8"));
    config.database.postgres.schemaPrefix = "rehearsal";
    await state.writeConfig(config);
    openOpenClawStateDatabase({ env: state.env });
    await closeOpenClawStateDatabaseAsync();
    const shared = state.statePath("state", "openclaw.sqlite");
    {
      using db = openNodeSqliteDatabase(shared);
      db.exec("CREATE TABLE fleet_cells (tenant_id TEXT PRIMARY KEY) STRICT");
    }
    const original = hash(source);
    const run = tasks.runDatabasePortTask;
    vi.spyOn(tasks, "runDatabasePortTask").mockImplementation(async (...args) => {
      if (args[0].operation === "preflight") {
        return;
      }
      if (args[0].operation === "migrate") {
        throw new Error(injected);
      }
      return await run(...args);
    });
    await expect(
      doctorDatabasePort({ family: "state", to: "postgres", dryRun: true }),
    ).resolves.toMatchObject({
      notes: [`${shared}: Skipped empty retained SQLite table fleet_cells`],
    });
    await expect(doctorDatabasePort({ to: "postgres" })).rejects.toThrow("private migrate");
    const saved = manifest(state);
    expect(saved.targets).toHaveLength(2);
    for (const target of saved.targets) {
      assert(target.original.engine === "sqlite");
      const family = target.original.path === shared ? "state" : "workboard";
      expect(target.intended).toMatchObject({
        engine: "postgres",
        namespace: `rehearsal_${family}_${target.storeId.replaceAll("-", "").slice(0, 16)}`,
      });
    }
    const inspection = saved.artifacts.find((artifact) =>
      artifact.path.endsWith("/inspection.json"),
    );
    assert(inspection);
    expect(JSON.parse(fs.readFileSync(inspection.path, "utf8"))).toEqual({
      notes: ["Skipped empty retained SQLite table fleet_cells"],
    });
    expect(hash(source)).toBe(original);
    await doctorDatabasePort({ rollback: recovery.databasePortManifestPath(state.stateDir) });
    expect(hash(source)).toBe(original);
  });
});

describe.skipIf(!connection)("database port command PostgreSQL conformance", () => {
  it("privately adds the first-use deletion phase when porting a current-schema journal", async () => {
    await fixture(async ({ state, client }) => {
      assert(client);
      openOpenClawStateDatabase({ env: state.env });
      await closeOpenClawStateDatabaseAsync();
      const shared = state.statePath("state", "openclaw.sqlite");
      {
        using db = openNodeSqliteDatabase(shared);
        db.exec(`
          ALTER TABLE agent_deletion_journal DROP COLUMN phase;
          ALTER TABLE agent_database_leases ADD COLUMN unported_data TEXT;
          INSERT INTO agent_deletion_journal (agent_id, agent_dir, workspace_dir, sessions_dir, created_at)
          VALUES ('retired', '/retired/agent', '/retired/workspace', '/retired/sessions', 17);
        `);
        assertOpenClawStateDatabaseForMaintenance(db, { pathname: shared });
      }
      const unported = hash(shared);
      await expect(doctorDatabasePort({ to: "postgres", dryRun: true })).rejects.toThrow(
        "Unknown or missing columns in agent_database_leases",
      );
      expect(hash(shared)).toBe(unported);
      {
        using db = openNodeSqliteDatabase(shared);
        db.exec("ALTER TABLE agent_database_leases DROP COLUMN unported_data");
      }
      const original = hash(shared);
      const preview = await doctorDatabasePort({ to: "postgres", dryRun: true });
      expect(preview).toMatchObject({ migrations: [shared] });
      expect(hash(shared)).toBe(original);
      const ported = await doctorDatabasePort({ to: "postgres" });
      const anchor = readBackupEngine(shared);
      assert(anchor.engine === "postgres");
      {
        using credentials = openClientCredentialCustody(state.env);
        assert(credentials);
        expect(readClientCredentialReceipt(credentials.database)).toMatchObject({
          phase: "complete",
          receipt: {
            source: { kind: "canonical", engine: "postgres", identity: anchor.storeId },
            sharedFile: readClientCredentialFileIdentity(shared),
          },
        });
      }
      expect(
        (
          await client.query(
            `SELECT agent_id, phase, created_at FROM "${anchor.namespace}".agent_deletion_journal`,
          )
        ).rows,
      ).toEqual([{ agent_id: "retired", phase: null, created_at: "17" }]);
      assert("manifest" in ported && typeof ported.manifest === "string");
      const saved = JSON.parse(
        fs.readFileSync(ported.manifest, "utf8"),
      ) as recovery.DatabasePortManifest;
      const captured = saved.targets.find(
        (target) => target.original.engine === "sqlite" && target.original.path === shared,
      );
      assert(captured);
      using originalDb = openNodeSqliteDatabase(captured.originalCapture.path, { readOnly: true });
      expect(
        originalDb
          .prepare("PRAGMA table_info(agent_deletion_journal)")
          .all()
          .map((column) => column.name),
      ).not.toContain("phase");
      expect(
        originalDb.prepare("SELECT agent_id, created_at FROM agent_deletion_journal").all(),
      ).toEqual([{ agent_id: "retired", created_at: 17 }]);
    }, true);
  }, 120_000);

  it("reconnects after a committed PostgreSQL transaction loses its reply before authorizing the anchor", async () => {
    assert(connection);
    const proxy = await loseOneCommittedReply(connection);
    try {
      await fixture(async ({ state, source, client }) => {
        assert(client);
        state.envVars.OPENCLAW_P36_TEST_DATABASE_URL = proxy.connection;
        state.applyEnv();
        const before = canonical(source);
        await doctorDatabasePort({ to: "postgres" });
        expect(proxy.dropped()).toBe(1);
        const anchor = readBackupEngine(source);
        assert(anchor.engine === "postgres");
        expect(await canonicalPostgres(client, anchor.namespace)).toEqual(before);
      }, true);
    } finally {
      await proxy.close();
    }
  }, 120_000);

  it("rolls back a preparing manifest including an external configured store before any target has been verified", async () => {
    await fixture(async ({ state, source }) => {
      const before = canonical(source);
      // Discovery chooses the path; the registered provider still owns its family.
      const agentDir = state.path("external", "agent");
      const external = path.join(agentDir, "openclaw-agent.sqlite");
      await fsp.mkdir(agentDir, { recursive: true });
      await fsp.copyFile(source, external);
      await state.writeConfig({
        ...JSON.parse(fs.readFileSync(state.configPath, "utf8")),
        agents: { entries: { external: { agentDir } } },
      });
      const run = tasks.runDatabasePortTask;
      vi.spyOn(tasks, "runDatabasePortTask").mockImplementation(async (...args) => {
        if (args[0].operation === "migrate") {
          throw new Error(injected);
        }
        return await run(...args);
      });
      await expect(doctorDatabasePort({ to: "postgres" })).rejects.toThrow("private migrate");
      vi.restoreAllMocks();
      const target = manifest(state).targets[0];
      assert(target);
      expect(target.verification).toBeNull();
      expect(
        manifest(state).targets.some(
          (entry) => entry.original.engine === "sqlite" && entry.original.path === external,
        ),
      ).toBe(true);
      await doctorDatabasePort({ rollback: recovery.databasePortManifestPath(state.stateDir) });
      expect(canonical(source)).toEqual(before);
      expect(canonical(external)).toEqual(before);
      expect(fs.existsSync(recovery.databasePortManifestPath(state.stateDir))).toBe(false);
    }, true);
  }, 120_000);

  it("resumes an interrupted schema-2 migration using its retained migration timestamp", async () => {
    await fixture(async ({ state, source, client }) => {
      assert(client);
      makeLegacy(source);
      const original = hash(source);
      const run = tasks.runDatabasePortTask;
      let migrationTime: unknown;
      vi.spyOn(tasks, "runDatabasePortTask").mockImplementation(async (...args) => {
        if (args[0].operation === "stage") {
          throw new Error(injected);
        }
        const result = await run(...args);
        if (args[0].operation === "migrate" && "sourcePath" in args[0]) {
          using db = openNodeSqliteDatabase(args[0].sourcePath, {
            readOnly: true,
            readBigInts: true,
          });
          migrationTime = db
            .prepare("SELECT applied_at FROM workboard_schema_migrations WHERE id = 'schema-3'")
            .get()?.applied_at;
        }
        return result;
      });
      await expect(doctorDatabasePort({ to: "postgres" })).rejects.toThrow("stage/materialize");
      vi.restoreAllMocks();
      expect(hash(source)).toBe(original);
      expect(typeof migrationTime).toBe("bigint");
      await doctorDatabasePort({ resume: recovery.databasePortManifestPath(state.stateDir) });
      const engine = readBackupEngine(source);
      assert(engine.engine === "postgres");
      expect(
        (
          await client.query(
            `SELECT applied_at FROM "${engine.namespace}".workboard_schema_migrations WHERE id = 'schema-3'`,
          )
        ).rows,
      ).toEqual([{ applied_at: String(migrationTime) }]);
      expect(
        (await client.query(`SELECT title FROM "${engine.namespace}".workboard_cards`)).rows,
      ).toEqual([{ title: "Card 0" }]);
    }, true);
  }, 120_000);

  it("rolls back a schema-2 source after its committed WAL has been checkpointed", async () => {
    await fixture(async ({ state, source }) => {
      makeLegacy(source);
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
        import { DatabaseSync } from "node:sqlite";
        const db = new DatabaseSync(process.argv[1]);
        db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE workboard_boards SET name='committed in WAL'");
        process.kill(process.pid, "SIGKILL");
      `,
          source,
        ],
        { env: state.env, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
      );
      expect(child.error).toBeUndefined();
      expect(child.signal).toBe("SIGKILL");
      expect(fs.statSync(`${source}-wal`).size).toBeGreaterThan(0);
      const run = tasks.runDatabasePortTask;
      let checkpointed = false;
      vi.spyOn(tasks, "runDatabasePortTask").mockImplementation(async (...args) => {
        const result = await run(...args);
        if (args[0].operation === "checkpoint") {
          checkpointed = true;
          throw new Error(injected);
        }
        return result;
      });
      await expect(doctorDatabasePort({ to: "postgres" })).rejects.toThrow("Database port");
      vi.restoreAllMocks();
      expect(checkpointed).toBe(true);
      await doctorDatabasePort({ rollback: recovery.databasePortManifestPath(state.stateDir) });
      using db = openNodeSqliteDatabase(source, { readOnly: true });
      expect(db.prepare("SELECT name FROM workboard_boards").get()?.name).toBe("committed in WAL");
      expect(db.prepare("SELECT id, applied_at FROM workboard_schema_migrations").all()).toEqual([
        { id: "schema-2", applied_at: 17 },
      ]);
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    }, true);
  }, 120_000);

  it("rebuilds an unverified interrupted anchor after verifying its committed namespace", async () => {
    await fixture(async ({ state, source, client }) => {
      assert(client);
      const before = hash(source);
      const run = tasks.runDatabasePortTask;
      let interrupted = false;
      vi.spyOn(tasks, "runDatabasePortTask").mockImplementation(async (...args) => {
        const result = await run(...args);
        if (args[0].operation === "stage" && !interrupted) {
          interrupted = true;
          assert("targetPath" in args[0] && typeof args[0].targetPath === "string");
          await fsp.truncate(args[0].targetPath, 0);
          throw new Error(injected);
        }
        return result;
      });
      await expect(doctorDatabasePort({ to: "postgres" })).rejects.toThrow("stage/materialize");
      vi.restoreAllMocks();
      expect(interrupted).toBe(true);
      expect(hash(source)).toBe(before);
      await doctorDatabasePort({ resume: recovery.databasePortManifestPath(state.stateDir) });
      const engine = readBackupEngine(source);
      assert(engine.engine === "postgres");
      expect(
        (await client.query(`SELECT title FROM "${engine.namespace}".workboard_cards`)).rows,
      ).toEqual([{ title: "Card 0" }]);
      expect(fs.existsSync(recovery.databasePortManifestPath(state.stateDir))).toBe(false);
    }, true);
  }, 120_000);

  it.each(["resume", "rollback"])(
    "recovers the whole registered store set after its second replacement fails (%s)",
    async (action) => {
      await fixture(async ({ state, source, client }) => {
        assert(client);
        const second = state.statePath("plugins", "workboard", "z-second.sqlite");
        await fsp.copyFile(source, second);
        const original = canonical(source);
        const resolve = pluginMetadata.resolvePluginMetadataSnapshot;
        vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshot").mockImplementation((...args) => {
          const snapshot = resolve(...args);
          return {
            ...snapshot,
            plugins: snapshot.plugins.map((plugin) => {
              if (plugin.id !== "workboard") {
                return plugin;
              }
              const resource = plugin.backupResources?.[0];
              assert(resource);
              return Object.assign({}, plugin, {
                backupResources: [
                  ...(plugin.backupResources ?? []),
                  { ...resource, relativePath: "plugins/workboard/z-second.sqlite" },
                ],
              });
            }),
          };
        });
        const prepare = snapshots.prepareVerifiedSqliteFile;
        let replacements = 0;
        const publication = vi
          .spyOn(snapshots, "prepareVerifiedSqliteFile")
          .mockImplementation(async (...args) => {
            const prepared = await prepare(...args);
            return {
              ...prepared,
              publish: async () => {
                if (++replacements === 2) {
                  throw new Error(injected);
                }
                return await prepared.publish();
              },
            };
          });
        await expect(doctorDatabasePort({ to: "postgres" })).rejects.toThrow("Database port");
        publication.mockRestore();
        expect(replacements).toBe(2);
        expect([source, second].map((file) => readBackupEngine(file).engine).toSorted()).toEqual([
          "postgres",
          "sqlite",
        ]);
        const saved = manifest(state);
        expect(saved.state).toBe("publishing");
        const shared = state.statePath("state", "openclaw.sqlite");
        expect(
          saved.targets.map((target) => {
            assert(target.original.engine === "sqlite");
            return target.original.path;
          }),
        ).toEqual([source, second, shared]);
        for (const target of saved.targets.slice(0, 2)) {
          expect(canonical(target.originalCapture.path)).toEqual(original);
        }
        await doctorDatabasePort(
          action === "resume"
            ? { resume: recovery.databasePortManifestPath(state.stateDir) }
            : { rollback: recovery.databasePortManifestPath(state.stateDir) },
        );
        for (const [index, file] of [source, second].entries()) {
          if (action === "rollback") {
            expect(canonical(file)).toEqual(original);
            continue;
          }
          const target = saved.targets[index];
          assert(target?.intended.engine === "postgres");
          const engine = readBackupEngine(file);
          expect(engine).toEqual({
            engine: "postgres",
            namespace: target.intended.namespace,
            storeId: target.storeId,
          });
          assert(engine.engine === "postgres");
          expect(await canonicalPostgres(client, engine.namespace)).toEqual(original);
        }
        expect(readBackupEngine(shared).engine).toBe(action === "rollback" ? "sqlite" : "postgres");
        expect(fs.existsSync(recovery.databasePortManifestPath(state.stateDir))).toBe(false);
      }, true);
    },
    120_000,
  );

  // Green CI runs 39068774273/39071119824 measured p95 at 82s; retain more than 2× headroom.
  it.each([false, true])(
    "rolls back a reverse port with retained PostgreSQL writes (missing namespace: %s)",
    async (missingNamespace) => {
      await fixture(async ({ state, source, client }) => {
        assert(client);
        const expected = state.path("expected.sqlite");
        await fsp.copyFile(source, expected);
        await doctorDatabasePort({ to: "postgres" });
        const original = readBackupEngine(source);
        assert(original.engine === "postgres");
        await client.query(
          `UPDATE "${original.namespace}".workboard_cards SET title = 'written after port'`,
        );
        await client.query(
          `UPDATE "${original.namespace}".workboard_notification_subscriptions SET last_event_sequence = 9007199254740997`,
        );
        {
          using db = openNodeSqliteDatabase(expected);
          db.exec(
            "UPDATE workboard_cards SET title = 'written after port'; UPDATE workboard_notification_subscriptions SET last_event_sequence = 9007199254740997",
          );
        }
        const write = configIo.writeConfigFile;
        vi.spyOn(configIo, "writeConfigFile").mockImplementationOnce(async (...args) => {
          await write(...args);
          throw new Error(injected);
        });
        await expect(doctorDatabasePort({ to: "sqlite" })).rejects.toThrow("switch config");
        vi.restoreAllMocks();
        expect(readBackupEngine(source)).toEqual({ engine: "sqlite" });
        const shared = state.statePath("state", "openclaw.sqlite");
        {
          using later = openNodeSqliteDatabase(shared);
          later.exec(
            "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)",
          );
          const mainFile = hash(shared);
          later.exec("INSERT INTO config_machine_state VALUES ('r13.external-drift', '1', 1)");
          expect(hash(shared)).toBe(mainFile);
          await expect(
            doctorDatabasePort({ rollback: recovery.databasePortManifestPath(state.stateDir) }),
          ).rejects.toThrow("canonical");
          later.exec("DELETE FROM config_machine_state WHERE state_key = 'r13.external-drift'");
        }
        if (missingNamespace) {
          await client.query(`DROP SCHEMA "${original.namespace}" CASCADE`);
        }
        await doctorDatabasePort({ rollback: recovery.databasePortManifestPath(state.stateDir) });
        const restored = readBackupEngine(source);
        assert(restored.engine === "postgres");
        expect(restored.storeId).toBe(original.storeId);
        expect(restored.namespace === original.namespace).toBe(!missingNamespace);
        expect(await canonicalPostgres(client, restored.namespace)).toEqual(canonical(expected));
      }, true);
    },
    180_000,
  );

  it.each(["environment", "absent", "changed environment"])(
    "restores the authored %s engine value after a committed config write fails",
    async (authored) => {
      await fixture(async ({ state, source }) => {
        state.envVars.OPENCLAW_P36_ENGINE = "sqlite";
        state.applyEnv();
        const original = JSON.parse(fs.readFileSync(state.configPath, "utf8"));
        if (authored !== "absent") {
          original.database.engine = "${OPENCLAW_P36_ENGINE}";
        } else {
          delete original.database.engine;
        }
        await state.writeConfig(original);
        const before = canonical(source);
        const write = configIo.writeConfigFile;
        vi.spyOn(configIo, "writeConfigFile").mockImplementationOnce(async (...args) => {
          await write(...args);
          throw new Error(injected);
        });
        await expect(doctorDatabasePort({ to: "postgres" })).rejects.toThrow("switch config");
        vi.restoreAllMocks();
        if (authored === "changed environment") {
          const committedStore = hash(source);
          const committedConfig = hash(state.configPath);
          state.envVars.OPENCLAW_P36_ENGINE = "postgres";
          state.applyEnv();
          await expect(
            doctorDatabasePort({ rollback: recovery.databasePortManifestPath(state.stateDir) }),
          ).rejects.toThrow("changed engine environment");
          expect(hash(source)).toBe(committedStore);
          expect(hash(state.configPath)).toBe(committedConfig);
          state.envVars.OPENCLAW_P36_ENGINE = "sqlite";
          state.applyEnv();
        }
        await doctorDatabasePort({ rollback: recovery.databasePortManifestPath(state.stateDir) });
        const restored = JSON.parse(fs.readFileSync(state.configPath, "utf8"));
        expect(restored.database).toEqual(original.database);
        expect(Object.hasOwn(restored.database, "engine")).toBe(authored !== "absent");
        expect(canonical(source)).toEqual(before);
      }, true);
    },
    120_000,
  );

  it("resumes through a symlinked ancestor by archiving without replacing stores or config", async () => {
    await fixture(async ({ state, source }) => {
      vi.spyOn(recovery, "archiveDatabasePortManifest").mockImplementationOnce(() => {
        throw new Error(injected);
      });
      await expect(doctorDatabasePort({ to: "postgres" })).rejects.toThrow("finalize/archive");
      vi.restoreAllMocks();
      expect(manifest(state).state).toBe("complete");
      const storeHash = hash(source);
      const configHash = hash(state.configPath);
      const homeAlias = state.path("home-alias");
      await fsp.symlink(state.home, homeAlias, "junction");
      state.envVars.OPENCLAW_STATE_DIR = path.join(homeAlias, ".openclaw");
      state.applyEnv();
      await doctorDatabasePort({ resume: recovery.databasePortManifestPath(state.stateDir) });
      expect(hash(source)).toBe(storeHash);
      expect(hash(state.configPath)).toBe(configHash);
      expect(fs.existsSync(recovery.databasePortManifestPath(state.stateDir))).toBe(false);
    }, true);
  }, 120_000);

  it.each(["source", "config"])(
    "refuses %s drift before the first replacement",
    async (changed) => {
      await fixture(async ({ state, source }) => {
        const run = tasks.runDatabasePortTask;
        const original = canonical(source);
        let mutated = false;
        vi.spyOn(tasks, "runDatabasePortTask").mockImplementation(async (...args) => {
          const result = await run(...args);
          if (!mutated && args[0].operation === "stage") {
            mutated = true;
            if (changed === "source") {
              using db = openNodeSqliteDatabase(source);
              db.exec("UPDATE workboard_boards SET name = 'externally changed'");
            } else {
              const config = JSON.parse(fs.readFileSync(state.configPath, "utf8"));
              config.update = { channel: "beta" };
              fs.writeFileSync(state.configPath, JSON.stringify(config));
            }
          }
          return result;
        });
        await expect(doctorDatabasePort({ to: "postgres" })).rejects.toThrow("Database port");
        expect(mutated).toBe(true);
        expect(readBackupEngine(source)).toEqual({ engine: "sqlite" });
        const saved = manifest(state);
        expect(saved.state).toBe("preparing");
        const target = saved.targets[0];
        assert(target);
        expect(canonical(target.originalCapture.path)).toEqual(original);
        if (changed === "config") {
          expect(canonical(source)).toEqual(original);
        }
      }, true);
    },
    120_000,
  );

  it("refuses a changed recovery artifact without changing the original", async () => {
    await fixture(async ({ state, source }) => {
      const before = canonical(source);
      const run = tasks.runDatabasePortTask;
      vi.spyOn(tasks, "runDatabasePortTask").mockImplementation(async (...args) => {
        if (args[0].operation === "migrate") {
          throw new Error(injected);
        }
        return await run(...args);
      });
      await expect(doctorDatabasePort({ to: "postgres" })).rejects.toThrow("private migrate");
      vi.restoreAllMocks();
      const target = manifest(state).targets[0];
      assert(target);
      const captured = target.originalCapture.path;
      fs.appendFileSync(captured, "corrupt-private-artifact");
      const error = await doctorDatabasePort({
        resume: recovery.databasePortManifestPath(state.stateDir),
      }).catch((failure: unknown) => failure);
      expectSafe(error, state.stateDir, "preflight");
      expect(canonical(source)).toEqual(before);
      expect(manifest(state).state).toBe("preparing");
    }, true);
  }, 120_000);
});
