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
          ["./database-engine/physical-store.js", new URL("../../infra/database-engine/physical-store.ts", preparationModule).href, "physical-store-old.mjs"],
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
