import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { getEnvironmentData, Worker } from "node:worker_threads";
import type { WorkboardDatabasePortApi } from "@openclaw/workboard-contract";
import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctorDatabasePort } from "../../commands/doctor-database-port.js";
import * as configIo from "../../config/io.js";
import * as pluginMetadata from "../../plugins/plugin-metadata-snapshot.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import { readBackupEngine } from "../../snapshot/database-backup.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as recovery from "../database-port-recovery.js";
import * as disk from "../disk-space.js";
import { acquireGatewayLock } from "../gateway-lock.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../runtime-worker-url.js";
import * as snapshots from "../sqlite-snapshot.js";
import * as tasks from "./port-command.worker.js";
import metadata from "./workboard-port.generated.json" with { type: "json" };

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const payload = ' {"first":1,"first":2,"escaped":"\\u0000"} \n';
const credentialRef = { source: "env", provider: "default", id: "OPENCLAW_P36_TEST_TOKEN" };
const injected = "postgres://private-user:private-secret@example.invalid/payload";
afterEach(() => vi.restoreAllMocks());

function canonicalCells(
  rows: Record<string, unknown>[],
  columns: { name: string; type: string }[],
  postgres = false,
) {
  return rows.map((row) =>
    columns.map(({ name, type }) => {
      const cell = row[name];
      const value = postgres && type === "bigint" && typeof cell === "string" ? BigInt(cell) : cell;
      return value instanceof Uint8Array
        ? ["blob", Buffer.from(value).toString("hex")]
        : [typeof value, value];
    }),
  );
}
function canonical(file: string) {
  using db = openNodeSqliteDatabase(file, { readOnly: true, readBigInts: true });
  return metadata.tables.map((table) => {
    const rows = db
      .prepare(
        `SELECT ${table.columns.map(({ name }) => `"${name}"`).join(",")} FROM "${table.name}" ORDER BY ${table.pk.map((name) => `"${name}"`).join(",")}`,
      )
      .all();
    return [table.name, canonicalCells(rows, table.columns)];
  });
}
async function canonicalPostgres(client: Client, namespace: string) {
  const cells = [];
  for (const table of metadata.tables) {
    const rows = (
      await client.query(
        `SELECT ${table.columns.map(({ name }) => `"${name}"`).join(",")} FROM "${namespace}"."${table.name}" ORDER BY ${table.pk.map((name) => `"${name}"`).join(",")}`,
      )
    ).rows;
    cells.push([table.name, canonicalCells(rows, table.columns, true)]);
  }
  return cells;
}

function makeLegacy(file: string) {
  using db = openNodeSqliteDatabase(file);
  db.exec(
    "DELETE FROM workboard_schema_migrations; INSERT INTO workboard_schema_migrations VALUES ('schema-2', 17); ALTER TABLE workboard_boards DROP COLUMN automation_job_id; ALTER TABLE workboard_boards DROP COLUMN kind; ALTER TABLE workboard_boards DROP COLUMN sessions_spec; PRAGMA user_version = 2",
  );
}

function hash(file: string) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function manifest(state: OpenClawTestState) {
  return JSON.parse(
    fs.readFileSync(recovery.databasePortManifestPath(state.stateDir), "utf8"),
  ) as recovery.DatabasePortManifest;
}
async function files(directory: string): Promise<string[]> {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? await files(file) : [file];
      }),
    )
  )
    .flat()
    .toSorted();
}
async function fixture(
  run: (input: { state: OpenClawTestState; source: string; client?: Client }) => Promise<void>,
  postgres = false,
  rows = 1,
) {
  await withOpenClawTestState(
    {
      scenario: "minimal",
      prefix: "port-command-",
      env: {
        OPENCLAW_P36_TEST_DATABASE_URL: connection ?? injected,
        OPENCLAW_P36_TEST_TOKEN: "synthetic-port-secret",
      },
    },
    async (state) => {
      const source = state.statePath("plugins", "workboard", "workboard.sqlite");
      await state.writeText(
        "plugins.json",
        JSON.stringify({ entries: { workboard: { enabled: false } } }),
      );
      await state.writeConfig({
        plugins: { $include: "plugins.json" },
        gateway: { auth: { mode: "token", token: credentialRef } },
        database: {
          engine: "sqlite",
          postgres: { connection: "${OPENCLAW_P36_TEST_DATABASE_URL}" },
        },
      });
      loadBundledPluginPublicArtifactModuleSync<{
        workboardDatabasePortApi: WorkboardDatabasePortApi<
          ReturnType<typeof openNodeSqliteDatabase>,
          never
        >;
      }>({
        dirName: "workboard",
        artifactBasename: "database-port-api.js",
      }).workboardDatabasePortApi.admitWorkboardPort(source);
      {
        using db = openNodeSqliteDatabase(source);
        db.exec("UPDATE workboard_schema_migrations SET applied_at = 17");
        db.prepare(
          "INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        ).run("board-é-🦞", "", -9223372036854775808n, 9223372036854775807n);
        const insert = db.prepare(
          "INSERT INTO workboard_cards (id, board_id, title, notes, status, priority, position, created_at, updated_at, automation_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        db.exec("BEGIN");
        for (let index = 0; index < rows; index++) {
          insert.run(
            `card-${String(index).padStart(4, "0")}`,
            "board-é-🦞",
            `Card ${index}`,
            index ? "x".repeat(4500) : null,
            "todo",
            "normal",
            index / 8,
            9007199254740993n,
            1,
            payload,
          );
        }
        db.exec("COMMIT");
        db.prepare("INSERT INTO workboard_attachment_blobs VALUES (?, ?)").run(
          "blob",
          Buffer.from([0, 255, 128, 1]),
        );
        db.prepare(
          "INSERT INTO workboard_card_notifications (id, card_id, ordinal, kind, message, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run("notification", "card-0000", 1, "status", "line one\nline two", 3, 9007199254740995n);
        db.prepare(
          "INSERT INTO workboard_notification_subscriptions (id, board_id, last_event_sequence, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).run("subscription", "board-é-🦞", 9007199254740995n, 0, 1);
      }
      const client = postgres ? new Client({ connectionString: connection }) : undefined;
      await client?.connect();
      try {
        await run({ state, source, client });
      } finally {
        vi.restoreAllMocks();
        if (client) {
          const directory = state.statePath("recovery", "database-port");
          if (fs.existsSync(directory)) {
            const owned = new Set<string>();
            for (const file of await files(directory)) {
              if (path.basename(file) !== "manifest.json") {
                continue;
              }
              const saved = JSON.parse(
                fs.readFileSync(file, "utf8"),
              ) as recovery.DatabasePortManifest;
              for (const target of saved.targets ?? []) {
                if (target.intended.engine === "postgres") {
                  owned.add(target.intended.namespace);
                }
                if (target.original.engine === "postgres") {
                  owned.add(target.original.namespace);
                }
              }
            }
            const current = readBackupEngine(source);
            if (current.engine === "postgres") {
              owned.add(current.namespace);
            }
            for (const namespace of owned) {
              assert.match(namespace, /^(port|restore)_[a-f0-9]+$/);
              await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
            }
          }
          await client.end();
        }
      }
    },
  );
}

async function loseOneCommittedReply(original: string) {
  const destination = new URL(original);
  const upstreamAddress = { host: destination.hostname, port: Number(destination.port || 5432) };
  const sockets = new Set<net.Socket>();
  let dropped = 0;
  const server = net.createServer((client) => {
    const upstream = net.createConnection(upstreamAddress);
    sockets.add(client);
    sockets.add(upstream);
    client.once("close", () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.once("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    let tail = Buffer.alloc(0);
    let backend = Buffer.alloc(0);
    let commit = false;
    const query = Buffer.concat([Buffer.from([81, 0, 0, 0, 11]), Buffer.from("COMMIT\0")]);
    client.on("data", (chunk) => {
      const observed = Buffer.concat([tail, Buffer.from(chunk)]);
      commit ||= observed.includes(query);
      tail = observed.subarray(Math.max(0, observed.length - query.length));
      upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      if (!commit) {
        client.write(chunk);
        return;
      }
      backend = Buffer.concat([backend, Buffer.from(chunk)]);
      while (backend.length >= 5) {
        const length = backend.readInt32BE(1) + 1;
        if (backend.length < length) {
          break;
        }
        const packet = backend.subarray(0, length);
        backend = backend.subarray(length);
        if (
          !dropped &&
          commit &&
          packet[0] === 67 &&
          packet.subarray(5).toString() === "COMMIT\0"
        ) {
          dropped++;
          client.destroy();
          upstream.destroy();
          return;
        }
        client.write(packet);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  destination.hostname = "127.0.0.1";
  destination.port = String(address.port);
  destination.searchParams.set("sslmode", "disable");
  return {
    connection: destination.toString(),
    dropped: () => dropped,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function expectSafe(error: unknown, source: string, phase: string) {
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain(phase);
  expect(String(error)).toContain(source);
  expect(String(error)).toContain("required");
  expect(String(error)).not.toContain(injected);
  expect(String(error)).not.toContain("private-secret");
  expect(String(error)).not.toContain(payload);
}

describe("database port command custody and inspection", () => {
  it("takes no persistent action for a dry run, including disabled workboard stores", async () => {
    await fixture(async ({ state, source }) => {
      const before = await files(state.stateDir);
      const hashes = before.map((file) => [file, hash(file)]);
      const result = await doctorDatabasePort({ to: "sqlite", dryRun: true });
      expect(result).toMatchObject({ phase: "preflight", stores: [source] });
      expect(await files(state.stateDir)).toEqual(before);
      expect(before.map((file) => [file, hash(file)])).toEqual(hashes);
      expect(JSON.stringify(result)).not.toContain(connection ?? injected);
      expect(JSON.stringify(result)).not.toContain(payload);
    });
  });

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

describe.skipIf(!connection)("database port command PostgreSQL conformance", () => {
  it("round-trips canonical cells, IDs, cursors and allocation facts through the command", async () => {
    await fixture(
      async ({ state, source, client }) => {
        assert(client);
        const before = canonical(source);
        const include = fs.readFileSync(state.statePath("plugins.json"), "utf8");
        const forward = await doctorDatabasePort({ to: "postgres" });
        const anchor = readBackupEngine(source);
        assert(anchor.engine === "postgres");
        expect(
          (
            await client.query(
              `SELECT sequence FROM "${anchor.namespace}".workboard_card_notifications`,
            )
          ).rows,
        ).toEqual([{ sequence: "9007199254740995" }]);
        const reverse = await doctorDatabasePort({ to: "sqlite" });
        expect(canonical(source)).toEqual(before);
        expect(readBackupEngine(source)).toEqual({ engine: "sqlite" });
        const authored = JSON.parse(fs.readFileSync(state.configPath, "utf8"));
        expect(authored).toMatchObject({
          plugins: { $include: "plugins.json" },
          gateway: { auth: { mode: "token", token: credentialRef } },
          database: {
            engine: "sqlite",
            postgres: { connection: "${OPENCLAW_P36_TEST_DATABASE_URL}" },
          },
        });
        expect(fs.readFileSync(state.statePath("plugins.json"), "utf8")).toBe(include);
        assert("manifest" in forward && typeof forward.manifest === "string");
        await expect(doctorDatabasePort({ rollback: forward.manifest })).rejects.toThrow(
          "Database port",
        );
        expect(canonical(source)).toEqual(before);
        const output = JSON.stringify({ forward, reverse });
        expect(output).not.toContain(connection);
        expect(output).not.toContain(payload);
        expect(output).not.toContain("synthetic-port-secret");
      },
      true,
      1001,
    );
  }, 120_000);

  it("reconnects after a committed PostgreSQL transaction loses its reply before authorizing the anchor", async () => {
    assert(connection);
    const proxy = await loseOneCommittedReply(connection);
    try {
      await fixture(async ({ state, source }) => {
        state.envVars.OPENCLAW_P36_TEST_DATABASE_URL = proxy.connection;
        state.applyEnv();
        const before = canonical(source);
        await doctorDatabasePort({ to: "postgres" });
        expect(proxy.dropped()).toBe(1);
        expect(readBackupEngine(source).engine).toBe("postgres");
        await doctorDatabasePort({ to: "sqlite" });
        expect(canonical(source)).toEqual(before);
      }, true);
    } finally {
      await proxy.close();
    }
  }, 120_000);

  it("rolls back a preparing manifest before any target has been verified", async () => {
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
      expect(target.verification).toBeNull();
      await doctorDatabasePort({ rollback: recovery.databasePortManifestPath(state.stateDir) });
      expect(canonical(source)).toEqual(before);
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
        expect(saved.targets).toHaveLength(2);
        for (const target of saved.targets) {
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
        expect(fs.existsSync(recovery.databasePortManifestPath(state.stateDir))).toBe(false);
      }, true);
    },
    120_000,
  );

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
    120_000,
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

  it("resumes a complete active manifest by archiving without replacing stores or config", async () => {
    await fixture(async ({ state, source }) => {
      vi.spyOn(recovery, "archiveDatabasePortManifest").mockImplementationOnce(() => {
        throw new Error(injected);
      });
      await expect(doctorDatabasePort({ to: "postgres" })).rejects.toThrow("finalize/archive");
      vi.restoreAllMocks();
      expect(manifest(state).state).toBe("complete");
      const storeHash = hash(source);
      const configHash = hash(state.configPath);
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

  it.each([
    "capture",
    "migrate",
    "stage",
    "verify",
    "replacement",
    "config",
    "config committed",
    "initial manifest",
    "preparing revision",
    "publishing revision",
    "complete revision",
  ])(
    "retains originals and recovers after a %s failure",
    async (point) => {
      await fixture(async ({ state, source }) => {
        const before = canonical(source);
        const originalConfig = fs.readFileSync(state.configPath, "utf8");
        let fired = false;
        const fail = () => {
          fired = true;
          throw new Error(injected);
        };
        if (["migrate", "stage", "verify"].includes(point)) {
          const run = tasks.runDatabasePortTask;
          vi.spyOn(tasks, "runDatabasePortTask").mockImplementation(async (...args) => {
            if (!fired && args[0].operation === point) {
              fail();
            }
            return await run(...args);
          });
        } else if (point === "capture") {
          vi.spyOn(snapshots, "createVerifiedSqliteSnapshot").mockImplementationOnce(async () =>
            fail(),
          );
        } else if (point === "replacement") {
          const prepare = snapshots.prepareVerifiedSqliteFile;
          vi.spyOn(snapshots, "prepareVerifiedSqliteFile").mockImplementation(async (...args) => {
            const prepared = await prepare(...args);
            return { ...prepared, publish: async () => fail() };
          });
        } else if (point === "config" || point === "config committed") {
          const write = configIo.writeConfigFile;
          vi.spyOn(configIo, "writeConfigFile").mockImplementationOnce(async (...args) => {
            if (point === "config committed") {
              await write(...args);
            }
            return fail();
          });
        } else {
          const write = recovery.writeDatabasePortManifest;
          vi.spyOn(recovery, "writeDatabasePortManifest").mockImplementation((...args) => {
            const value = args[1];
            if (
              !fired &&
              ((point === "initial manifest" && value.revision === 1) ||
                (point === "preparing revision" &&
                  value.state === "preparing" &&
                  value.revision > 1) ||
                (point === "publishing revision" && value.state === "publishing") ||
                (point === "complete revision" && value.state === "complete"))
            ) {
              fail();
            }
            return write(...args);
          });
        }
        const error = await doctorDatabasePort({ to: "postgres" }).catch(
          (failure: unknown) => failure,
        );
        expect(fired).toBe(true);
        expectSafe(
          error,
          ["config", "config committed", "complete revision"].includes(point)
            ? state.stateDir
            : source,
          point === "capture" ? "capture originals" : "Database port",
        );
        vi.restoreAllMocks();
        const active = recovery.databasePortManifestPath(state.stateDir);
        if (fs.existsSync(active)) {
          const saved = manifest(state);
          const target = saved.targets[0];
          assert(target);
          const captured = target.originalCapture.path;
          expect(canonical(captured)).toEqual(before);
          if (!["config", "config committed", "complete revision"].includes(point)) {
            expect(canonical(source)).toEqual(before);
            expect(fs.readFileSync(state.configPath, "utf8")).toBe(originalConfig);
          }
          const rollback = ["config", "config committed", "complete revision"].includes(point);
          await doctorDatabasePort(rollback ? { rollback: active } : { resume: active });
          expect(fs.existsSync(active)).toBe(false);
          if (!rollback) {
            await doctorDatabasePort({ to: "sqlite" });
          }
          expect(canonical(source)).toEqual(before);
        } else {
          expect(canonical(source)).toEqual(before);
          expect(fs.readFileSync(state.configPath, "utf8")).toBe(originalConfig);
        }
      }, true);
    },
    120_000,
  );
});
