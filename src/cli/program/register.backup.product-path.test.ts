import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { writeJsonFile } from "../../../test/helpers/temp-repo.js";
import { listArchiveEntries } from "../../infra/backup-create.test-support.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { sqliteWorkerPreloadEnv } from "../../infra/sqlite-worker-preload.test-support.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { cliRecoveryEntrypoints } from "../cli-entrypoint.test-support.js";
import { runCliProcessChild } from "../cli-process-child.test-helpers.js";

function runBackupCli(
  state: OpenClawTestState,
  includeWorkspace = false,
  env: NodeJS.ProcessEnv = {},
) {
  return runCliProcessChild({
    nodeArgs: [
      ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)),
      "backup",
      "create",
      "--output",
      state.path("backup.tar.gz"),
      ...(includeWorkspace ? [] : ["--no-include-workspace"]),
      "--verify",
      "--json",
    ],
    env: { ...process.env, ...state.env, ...env, OPENCLAW_TEST_RUNTIME_LOG: "1" },
  });
}

it.each([true, false])(
  "backup create retains workspace-discovered owners under state write load (includeWorkspace=%s)",
  async (includeWorkspace) => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const pluginRoot = path.join(state.workspaceDir, ".openclaw/extensions/backup-fixture");
      await fs.writeFile(path.join(state.workspaceDir, "workspace-only-marker.txt"), "workspace");
      writeJsonFile(path.join(pluginRoot, "package.json"), {
        name: "backup-fixture",
        version: "1.0.0",
        openclaw: { extensions: ["./index.cjs"] },
      });
      await fs.writeFile(path.join(pluginRoot, "index.cjs"), "module.exports = { register() {} };");
      writeJsonFile(path.join(pluginRoot, "openclaw.plugin.json"), {
        id: "backup-fixture",
        configSchema: { type: "object", properties: {} },
        backupResources: [{ disposition: "include", scope: "state", relativePath: "plugin-data" }],
      });
      await state.writeConfig({
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        plugins: { allow: ["backup-fixture"], entries: { "backup-fixture": { enabled: true } } },
      });
      const rootPath = openOpenClawStateDatabase().path;
      closeOpenClawStateDatabase();
      await fs.mkdir(state.statePath("plugin-data"));
      const writer = new Worker(
        `
          const { parentPort, workerData } = require('node:worker_threads');
          const { DatabaseSync } = require('node:sqlite');
          const plugin = new DatabaseSync(workerData.plugin);
          plugin.exec("CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('owned');");
          plugin.close();
          const db = new DatabaseSync(workerData.root, { timeout: 5000 });
          db.exec('PRAGMA journal_mode=WAL; CREATE TABLE contention_fixture(value BLOB); INSERT INTO contention_fixture VALUES(zeroblob(1048576));');
          const write = db.prepare('UPDATE contention_fixture SET value=randomblob(1048576)');
          let stopped = false;
          parentPort.on('message', () => { stopped = true; });
          function tick() {
            if (stopped) { db.close(); parentPort.close(); return; }
            write.run(); setImmediate(tick);
          }
          tick(); parentPort.postMessage('ready');
        `,
        {
          eval: true,
          workerData: { root: rootPath, plugin: state.statePath("plugin-data/records.sqlite") },
        },
      );
      const finished = once(writer, "exit").then(
        ([code]: readonly unknown[]) => code,
        (error: unknown) => error,
      );
      try {
        await once(writer, "message");
        const result = await runBackupCli(state, includeWorkspace);
        expect(result.code, result.stderr).toBe(0);
        const archive = JSON.parse(result.stdout);
        expect(archive).toMatchObject({ agentRoots: [{ agentId: "main" }], verified: true });
        expect(archive.warnings ?? []).toEqual([]);
        const entries = await listArchiveEntries(state.path("backup.tar.gz"));
        expect(entries.some((entry) => entry.endsWith("/plugin-data/records.sqlite"))).toBe(true);
        expect(entries.some((entry) => entry.endsWith("/workspace-only-marker.txt"))).toBe(
          includeWorkspace,
        );
      } finally {
        writer.postMessage("stop", []);
        expect(await finished).toBe(0);
      }
    });
  },
);

it("backup create refuses unreadable discovery state even without workspaces", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    await state.writeConfig({ agents: { entries: { main: {} } } });
    await fs.mkdir(state.statePath("state"));
    await fs.writeFile(state.statePath("state/openclaw.sqlite"), "unreadable database");
    const result = await runBackupCli(state);
    expect(result.code).toBe(1);
    const failure = JSON.parse(result.stdout);
    expect(failure).toMatchObject({ ok: false, error: { type: "cli_error" } });
    expect(failure.error.message).toContain(
      `Cannot read shared state for discovery: ${state.statePath("state/openclaw.sqlite")}.`,
    );
    expect(failure.error.message).toContain("file is not a database");
    await expect(fs.stat(state.path("backup.tar.gz"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("completes when the SQLite snapshot outlives the audit lease", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "backup-cli-audit-lease-", scenario: "minimal" },
    async (state) => {
      await state.writeConfig({ gateway: { mode: "local" } });
      await state.writeText(
        "logs/config-audit.jsonl",
        `${JSON.stringify({
          ts: "2026-09-03T00:00:00.000Z",
          source: "config-io",
          event: "config.write",
          argv: ["openclaw", "config", "set", "proof", "lease"],
          execArgv: [],
        })}\n`,
      );
      const markerPath = state.path("sqlite-backup-entered");
      const preloadPath = await state.writeText(
        "shift-clock-at-sqlite-backup.cjs",
        `
            const fs = require("node:fs");
            const { syncBuiltinESMExports } = require("node:module");
            const sqlite = process.getBuiltinModule("node:sqlite");
            const originalBackup = sqlite.backup.bind(sqlite);
            if (process.versions.bun) {
              const workerThreads = require("node:worker_threads");
              const OriginalWorker = workerThreads.Worker;
              const preload = process.env.OPENCLAW_TEST_SQLITE_WORKER_PRELOAD;
              // The CLI's nested Workers do not inherit the Vitest parent's preload spy.
              workerThreads.Worker = class Worker extends OriginalWorker {
                constructor(filename, options = {}) {
                  super(filename, {
                    ...options,
                    execArgv: [...(options.execArgv ?? process.execArgv), "--preload", preload],
                  });
                }
              };
            }
            const markerPath = process.env.PROOF_SNAPSHOT_MARKER;
            const realNow = Date.now.bind(Date);
            // Acquisition runs in a worker; every isolate must observe the same elapsed time.
            Date.now = () => realNow() + (fs.existsSync(markerPath) ? 61_000 : 0);
            sqlite.backup = async (...args) => {
              if (!fs.existsSync(markerPath)) {
                fs.writeFileSync(markerPath, "entered\\n", { mode: 0o600 });
              }
              return await originalBackup(...args);
            };
            syncBuiltinESMExports();
          `,
      );
      const result = await runBackupCli(state, false, {
        ...sqliteWorkerPreloadEnv(preloadPath),
        OPENCLAW_TEST_CONSOLE: "1",
        PROOF_SNAPSHOT_MARKER: markerPath,
      });

      expect(result.code, result.stderr).toBe(0);
      expect(await fs.readFile(markerPath, "utf8")).toBe("entered\n");
      expect((await fs.stat(state.path("backup.tar.gz"))).size).toBeGreaterThan(0);
    },
  );
});
