import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

function runBackupCli(params: {
  env: NodeJS.ProcessEnv;
  outputPath: string;
  preloadPath?: string;
  includeWorkspace?: boolean;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        ...(params.preloadPath ? ["--import", params.preloadPath] : []),
        "--import",
        "tsx",
        path.resolve("src/entry.ts"),
        "backup",
        "create",
        "--output",
        params.outputPath,
        ...(params.includeWorkspace ? [] : ["--no-include-workspace"]),
        "--verify",
        "--json",
      ],
      {
        env: { ...params.env, OPENCLAW_TEST_RUNTIME_LOG: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("backup create CLI", () => {
  it.each([true, false])(
    "backup create retains workspace-discovered owners under state write load (includeWorkspace=%s)",
    async (includeWorkspace) => {
      await withOpenClawTestState({ layout: "state-only" }, async (state) => {
        const pluginRoot = path.join(
          state.workspaceDir,
          ".openclaw",
          "extensions",
          "backup-fixture",
        );
        await fs.mkdir(pluginRoot, { recursive: true });
        await fs.writeFile(path.join(state.workspaceDir, "workspace-only-marker.txt"), "workspace");
        await fs.writeFile(
          path.join(pluginRoot, "package.json"),
          JSON.stringify({
            name: "backup-fixture",
            version: "1.0.0",
            openclaw: { extensions: ["./index.cjs"] },
          }),
        );
        await fs.writeFile(
          path.join(pluginRoot, "index.cjs"),
          "module.exports = { register() {} };",
        );
        await fs.writeFile(
          path.join(pluginRoot, "openclaw.plugin.json"),
          JSON.stringify({
            id: "backup-fixture",
            configSchema: { type: "object", properties: {} },
            backupResources: [
              { disposition: "include", scope: "state", relativePath: "plugin-data" },
            ],
          }),
        );
        await state.writeConfig({
          agents: { entries: { main: { workspace: state.workspaceDir } } },
          plugins: { allow: ["backup-fixture"], entries: { "backup-fixture": { enabled: true } } },
        });
        const root = openOpenClawStateDatabase();
        const rootPath = root.path;
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
        const finished = new Promise<number | Error>((resolve) => {
          writer.once("error", resolve);
          writer.once("exit", resolve);
        });
        try {
          await new Promise<void>((resolve, reject) => {
            writer.once("message", () => resolve());
            writer.once("error", reject);
          });
          const outputPath = state.path("backup.tar.gz");
          const result = await runBackupCli({
            env: { ...process.env, ...state.env },
            outputPath,
            includeWorkspace,
          });
          expect(result.code, result.stderr).toBe(0);
          const archive = JSON.parse(result.stdout);
          expect(archive.agentRoots).toEqual([expect.objectContaining({ agentId: "main" })]);
          expect(archive.verified).toBe(true);
          expect(archive.warnings ?? []).toEqual([]);
          const entries: string[] = [];
          await tar.t({
            file: outputPath,
            onReadEntry: (entry) => {
              entries.push(entry.path);
            },
          });
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
      const outputPath = state.path("backup.tar.gz");
      const result = await runBackupCli({ env: { ...process.env, ...state.env }, outputPath });
      expect(result.code).toBe(1);
      expect(result.stderr).not.toContain("Config invalid");
      expect(result.stderr).toContain("Cannot read shared state for discovery");
      await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
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
          "shift-clock-at-sqlite-backup.mjs",
          `
            import fs from "node:fs";
            import { syncBuiltinESMExports } from "node:module";
            const sqlite = process.getBuiltinModule("node:sqlite");
            const originalBackup = sqlite.backup.bind(sqlite);
            let shifted = false;
            sqlite.backup = async (...args) => {
              if (!shifted) {
                shifted = true;
                fs.writeFileSync(process.env.PROOF_SNAPSHOT_MARKER, "entered\\n", { mode: 0o600 });
                const realNow = Date.now.bind(Date);
                Date.now = () => realNow() + 61_000;
              }
              return await originalBackup(...args);
            };
            syncBuiltinESMExports();
          `,
        );
        const outputPath = state.path("backup.tar.gz");

        const result = await runBackupCli({
          env: {
            ...process.env,
            ...state.env,
            OPENCLAW_TEST_CONSOLE: "1",
            PROOF_SNAPSHOT_MARKER: markerPath,
          },
          outputPath,
          preloadPath,
        });

        expect(result.code, result.stderr).toBe(0);
        expect(await fs.readFile(markerPath, "utf8")).toBe("entered\n");
        expect((await fs.stat(outputPath)).size).toBeGreaterThan(0);
      },
    );
  });
});
