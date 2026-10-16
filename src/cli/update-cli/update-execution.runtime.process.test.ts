import "../../test-utils/prepare-compiled-subprocesses.js";
import { expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { formatCliProcessFailure, runCliProcessChild } from "../cli-process-child.test-helpers.js";

it("captures databases after the updater's old lazy import chunks are replaced", async () => {
  await withOpenClawTestState(
    { prefix: "openclaw-update-backup-runtime-", scenario: "minimal", applyEnv: false },
    async (state) => {
      const script = String.raw`
        import assert from "node:assert/strict";
        import fs from "node:fs/promises";
        import { registerHooks } from "node:module";
        import path from "node:path";
        import { DatabaseSync } from "node:sqlite";
        import { pathToFileURL } from "node:url";

        const root = ${JSON.stringify(state.root)};
        const stateDir = ${JSON.stringify(state.stateDir)};
        const backupModule = ${JSON.stringify(new URL("../../infra/update-database-backup.ts", import.meta.url).href)};
        const preparationModule = ${JSON.stringify(new URL("./update-execution.runtime.ts", import.meta.url).href)};
        const oldDist = path.join(root, "old-dist");
        const targets = [
          ["./backup-sqlite-snapshot.js", new URL("../../infra/backup-sqlite-snapshot.ts", preparationModule).href, "backup-sqlite-snapshot-old.mjs"],
          ["../snapshot/database-backup.js", new URL("../../snapshot/database-backup.ts", preparationModule).href, "database-backup-old.mjs"],
        ];
        await fs.mkdir(oldDist);
        for (const [, target, name] of targets) {
          await fs.writeFile(path.join(oldDist, name), "export * from " + JSON.stringify(target) + ";\n");
        }
        registerHooks({
          resolve(specifier, context, nextResolve) {
            const target = context.parentURL === backupModule
              ? targets.find(([request]) => request === specifier)
              : undefined;
            return target
              ? { url: pathToFileURL(path.join(oldDist, target[2])).href, shortCircuit: true }
              : nextResolve(specifier, context);
          },
        });

        await import(preparationModule);
        await fs.rm(oldDist, { recursive: true });
        const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
        await fs.mkdir(path.dirname(databasePath), { recursive: true });
        using database = new DatabaseSync(databasePath);
        database.exec("PRAGMA user_version=17; CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES ('retained'); CREATE TABLE agent_databases(path TEXT);");
        database.close();
        const { createUpdateDatabaseBackup } = await import(backupModule);
        const captured = await createUpdateDatabaseBackup({
          backupRoot: path.join(root, "backup"),
          stateDir,
          config: {},
          env: process.env,
        });
        const snapshot = captured.databases.find((entry) => entry.path === databasePath);
        assert(snapshot, "shared database was not backed up");
        using restored = new DatabaseSync(snapshot.snapshotPath, { readOnly: true });
        assert.deepEqual(
          restored.prepare("SELECT value FROM payload").all().map((row) => row.value),
          ["retained"],
        );
        console.log("UPDATE_BACKUP_AFTER_REPLACEMENT_OK");
      `;
      const result = await runCliProcessChild({
        nodeExecutable: resolveTestNodeExecPath(),
        nodeArgs: ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", script],
        env: { PATH: process.env.PATH, ...state.envVars },
      });
      const failure = formatCliProcessFailure({ reason: "Backup child failed", ...result });
      expect(result.signal, failure).toBeNull();
      expect(result.code, failure).toBe(0);
      expect(result.stdout, failure).toContain("UPDATE_BACKUP_AFTER_REPLACEMENT_OK");
    },
  );
});

it("retains the PostgreSQL rollback closure before replacing update chunks", async () => {
  await withOpenClawTestState(
    { prefix: "openclaw-update-pg-rollback-runtime-", scenario: "minimal", applyEnv: false },
    async (state) => {
      const script = String.raw`
        import assert from "node:assert/strict";
        import { createHash } from "node:crypto";
        import fs from "node:fs/promises";
        import { registerHooks } from "node:module";
        import path from "node:path";
        import { DatabaseSync } from "node:sqlite";
        import { pathToFileURL } from "node:url";

        const root = ${JSON.stringify(state.root)};
        const stateDir = ${JSON.stringify(state.stateDir)};
        const restoreModule = ${JSON.stringify(new URL("../../infra/update-database-restore.ts", import.meta.url).href)};
        const preparationModule = ${JSON.stringify(new URL("./update-execution.runtime.ts", import.meta.url).href)};
        const oldDist = path.join(root, "old-dist");
        const targets = [
          ["../config/io.js", new URL("../../config/io.ts", preparationModule).href, "config-io-old.mjs"],
          ["../snapshot/database-backup.js", new URL("../../snapshot/database-backup.ts", preparationModule).href, "database-backup-old.mjs"],
        ];
        await fs.mkdir(oldDist);
        for (const [, target, name] of targets) {
          await fs.writeFile(path.join(oldDist, name), "export * from " + JSON.stringify(target) + ";\n");
        }
        registerHooks({
          resolve(specifier, context, nextResolve) {
            const target = context.parentURL === restoreModule
              ? targets.find(([request]) => request === specifier)
              : undefined;
            return target
              ? { url: pathToFileURL(path.join(oldDist, target[2])).href, shortCircuit: true }
              : nextResolve(specifier, context);
          },
        });
        const { withOpenClawStateStartupMigrationCheckpointDatabase } = await import(
          ${JSON.stringify(new URL("../../state/openclaw-state-db.ts", import.meta.url).href)}
        );
        const { closeOpenClawStateDatabaseAsync } = await import(
          ${JSON.stringify(new URL("../../state/openclaw-state-db-cache.ts", import.meta.url).href)}
        );
        withOpenClawStateStartupMigrationCheckpointDatabase(() => {});
        await closeOpenClawStateDatabaseAsync();
        const source = path.join(stateDir, "plugins/workboard/workboard.sqlite");
        await fs.mkdir(path.dirname(source), { recursive: true });
        {
          using db = new DatabaseSync(source);
          db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT); INSERT INTO openclaw_engine_anchor VALUES ('e3b4e990-c0f1-4ec7-a5d1-4e1c6824f80f', 'postgres', 'rollback_fixture');");
        }
        const bytes = await fs.readFile(source);
        const directory = path.join(root, "rollback");
        await fs.mkdir(directory);
        const snapshotPath = path.join(directory, "workboard.sqlite");
        await fs.writeFile(snapshotPath, bytes);
        const exportDirectory = path.join(directory, "pending-export");
        await fs.mkdir(exportDirectory);
        await fs.writeFile(path.join(exportDirectory, ".pending"), "");
        const backup = {
          directory,
          databases: [{ path: source, snapshotPath, userVersion: 0,
            sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length,
            engine: "postgres", storeId: "e3b4e990-c0f1-4ec7-a5d1-4e1c6824f80f",
            namespace: "rollback_fixture", exportDirectory }],
          missingPaths: [], sourcePaths: [source], sourceGenerations: {}, warnings: [],
        };
        await import(preparationModule);
        await fs.rm(oldDist, { recursive: true });
        const { restoreUpdateDatabaseBackup } = await import(restoreModule);
        await assert.rejects(
          restoreUpdateDatabaseBackup({ backup, runId: "rollback_fixture", env: process.env, assertCurrent() {} }),
          /PostgreSQL backup is incomplete/,
        );
        assert.deepEqual(await fs.readFile(source), bytes);
        console.log("UPDATE_PG_ROLLBACK_RUNTIME_OK");
      `;
      const result = await runCliProcessChild({
        nodeExecutable: resolveTestNodeExecPath(),
        nodeArgs: ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", script],
        env: { PATH: process.env.PATH, ...state.envVars },
      });
      const failure = formatCliProcessFailure({ reason: "Rollback child failed", ...result });
      expect(result.signal, failure).toBeNull();
      expect(result.code, failure).toBe(0);
      expect(result.stdout, failure).toContain("UPDATE_PG_ROLLBACK_RUNTIME_OK");
    },
  );
});
