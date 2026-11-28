import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandBuffered } from "../process/exec.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { UpdateDatabaseBackupSchema } from "./update-database-backup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["DELETE", "WAL"])(
  "round-trips a 9.37 %s capture under its parent lease",
  async (journal) => {
    const root = fs.realpathSync(dirs.make("update-legacy-lease-"));
    const stateDir = path.join(root, "state");
    const shared = path.join(stateDir, "state", "openclaw.sqlite");
    const agent = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    const retained = path.join(stateDir, "retained", "plugin.sqlite");
    const pluginRoot = path.join(root, "installed-plugin");
    const backupRoot = path.join(root, "capture");
    const stagingRoot = `${backupRoot}.databases`;
    fs.mkdirSync(pluginRoot);
    fs.mkdirSync(stagingRoot);
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        name: "lease-fixture",
        version: "1.0.0",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    fs.writeFileSync(path.join(pluginRoot, "index.js"), "throw new Error('metadata only');");
    fs.writeFileSync(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: "lease-fixture",
        configSchema: { type: "object", properties: {} },
        backupResources: [
          {
            scope: "state",
            relativePath: "retained",
            disposition: "include",
            databaseFamily: "state",
          },
        ],
      }),
    );
    for (const [file, version] of [
      [shared, 19],
      [agent, 24],
      [retained, 7],
    ] as const) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      using db = openNodeSqliteDatabase(file);
      db.exec(`PRAGMA user_version=${version}; CREATE TABLE retained(value TEXT);`);
      db.prepare("INSERT INTO retained VALUES (?)").run("survives capture");
      if (file === shared) {
        db.exec(
          "CREATE TABLE agent_databases(path TEXT, agent_id TEXT); CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER);",
        );
        db.prepare("INSERT INTO agent_databases VALUES (?, ?)").run(agent, "main");
      }
    }
    const walFiles = [shared, `${shared}-wal`, `${shared}-shm`];
    let walFamily: Buffer[] | undefined;
    {
      using sharedHandle = openNodeSqliteDatabase(shared);
      sharedHandle.exec(`PRAGMA journal_mode=${journal}; PRAGMA wal_autocheckpoint=0;`);
      sharedHandle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      sharedHandle.prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)").run(
        "plugins.installedIndex",
        JSON.stringify({
          revision: 1,
          index: {
            installRecords: {
              "lease-fixture": { source: "path", sourcePath: pluginRoot, installPath: pluginRoot },
            },
          },
        }),
      );
      sharedHandle.prepare("UPDATE retained SET value=?").run("survives capture");
      if (journal === "WAL") {
        walFamily = walFiles.map((file) => fs.readFileSync(file));
      }
    }
    if (walFamily) {
      walFiles.forEach((file, index) => fs.writeFileSync(file, walFamily[index]!));
      const mainOnly = path.join(root, "main-only.sqlite");
      fs.copyFileSync(shared, mainOnly);
      using image = openNodeSqliteDatabase(mainOnly, { readOnly: true });
      expect(image.prepare("SELECT value_json FROM config_machine_state").get()).toBeUndefined();
    }
    const sources = [shared, agent, retained, ...(journal === "WAL" ? [`${shared}-wal`] : [])];
    const before = sources.map((file) => fs.readFileSync(file));
    const env = { ...process.env, HOME: root, OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: stateDir };
    const input = {
      stateDir,
      config: { plugins: { entries: { "lease-fixture": { enabled: false } } } },
      env: { HOME: root, OPENCLAW_HOME: root },
      backupRoot,
      stagingRoot,
    };
    const discoveryPreload = path.join(root, "discovery-source-guard.cjs");
    fs.writeFileSync(
      discoveryPreload,
      `const sqlite = require("node:sqlite");
const { fileURLToPath } = require("node:url");
sqlite.DatabaseSync = new Proxy(sqlite.DatabaseSync, {
  construct(target, args, newTarget) {
    const file = String(args[0]);
    const pathname = file.startsWith("file:") ? fileURLToPath(file) : file;
    if (pathname === ${JSON.stringify(shared)}) {
      throw new Error("Discovery opened the source SQLite database");
    }
    return Reflect.construct(target, args, newTarget);
  },
});
require("node:module").syncBuiltinESMExports();`,
    );
    const run = async (request: Record<string, unknown>): Promise<unknown> => {
      const result = await runCommandBuffered(
        [
          process.execPath,
          ...(request.mode === "discover" ? ["--require", discoveryPreload] : []),
          ...resolveRuntimeWorkerArgv(
            resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState),
          ),
        ],
        {
          input: JSON.stringify({ ...input, ...request }),
          baseEnv: env,
          env: { XDG_CACHE_HOME: stagingRoot },
          timeoutMs: 30_000,
          maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
        },
      );
      expect(result.code, result.stderr.toString("utf8")).toBe(0);
      return JSON.parse(result.stdout.toString("utf8"));
    };
    const lease = await acquireGatewayLock({ env, role: "sqlite-maintenance", allowInTests: true });
    if (!lease) {
      throw new Error("Could not acquire updater maintenance lease");
    }
    try {
      const legacyVersion = z.object({
        path: z.string(),
        userVersion: z.number().nullable(),
        contentVersion: z.number().optional(),
      });
      const legacyPlan = z.object({
        files: z.array(
          z.tuple([z.string(), z.object({ spellings: z.tuple([z.string()], z.string()) })]),
        ),
        sharedVersion: legacyVersion,
      });
      const discoveryFiles = journal === "WAL" ? walFiles : [shared];
      const discoveryBefore = discoveryFiles.map((file) => fs.readFileSync(file));
      const inspectionPlan = legacyPlan.parse(await run({ mode: "discover" }));
      expect(discoveryFiles.map((file) => fs.readFileSync(file))).toEqual(discoveryBefore);
      expect(inspectionPlan.files.flatMap(([, file]) => file.spellings)).toContain(retained);
      const backup = UpdateDatabaseBackupSchema.parse(
        await run({ mode: "database-backup", inspectionPlan }),
      );
      expect(backup.databases.map((database) => database.path).toSorted()).toEqual(
        [shared, agent, retained].toSorted(),
      );
      for (const database of backup.databases) {
        using image = openNodeSqliteDatabase(database.snapshotPath, { readOnly: true });
        expect(image.prepare("SELECT value FROM retained").all()).toEqual([
          { value: "survives capture" },
        ]);
        expect(image.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      }
      const versions = z
        .array(legacyVersion)
        .parse(await run({ mode: "versions", inspectionPlan }));
      expect(versions).toEqual([
        { path: agent, userVersion: 24 },
        { path: shared, userVersion: 19, contentVersion: 19 },
      ]);
      expect(sources.map((file) => fs.readFileSync(file))).toEqual(before);
      lease.assertCurrent();
    } finally {
      await lease.release();
    }
  },
);
