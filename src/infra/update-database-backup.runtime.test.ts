import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { withUserPathBaseDirectory } from "./home-dir.js";
import { createUpdateDatabaseBackup } from "./update-database-backup.js";

// mock-isolation: Activation removed the parent's cold backup chunk; the retained child uses real code.
vi.mock("./backup-sqlite-snapshot.js", () => {
  throw new Error("Installed backup module was replaced");
});

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["sqlite", "sqlite-maintenance", "postgres", "postgres-relative"] as const)(
  "keeps first-use %s capture in the retained child after runtime replacement",
  async (engine) => {
    const root = dirs.make("update-backup-runtime-");
    const stateDir = path.join(root, "state");
    const workboard = fileURLToPath(new URL("../../extensions/workboard", import.meta.url));
    const postgres = engine.startsWith("postgres");
    const invocationDir = path.join(root, "invocation");
    if (engine === "postgres-relative") {
      await fs.mkdir(path.join(invocationDir, "extensions"), { recursive: true });
      await fs.symlink(
        workboard,
        path.join(invocationDir, "extensions/workboard"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    const source = path.join(
      stateDir,
      postgres ? "plugins/workboard/workboard.sqlite" : "state/openclaw.sqlite",
    );
    await fs.mkdir(path.dirname(source), { recursive: true });
    {
      using db = new DatabaseSync(source);
      if (!postgres) {
        db.exec(
          "PRAGMA user_version=17; CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES('preserved');",
        );
      } else {
        db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
        db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(
          "e3b4e990-c0f1-4ec7-a5d1-4e1c6824f80f",
          "retained_workboard",
        );
      }
    }
    const shared = path.join(stateDir, "state/openclaw.sqlite");
    await fs.mkdir(path.dirname(shared), { recursive: true });
    {
      using db = new DatabaseSync(shared);
      db.exec("CREATE TABLE config_machine_state (state_key TEXT, value_json TEXT)");
      const write = db.prepare("INSERT INTO config_machine_state VALUES (?, ?)");
      write.run("plugins.bundledDiscovery", JSON.stringify("allowlist"));
      write.run(
        "plugins.installedIndex",
        JSON.stringify({
          revision: 1,
          index: {
            version: 1,
            hostContractVersion: "2026.10.3",
            compatRegistryVersion: "fixture",
            migrationVersion: 1,
            policyHash: "fixture",
            generatedAtMs: 1,
            installRecords:
              engine === "postgres-relative"
                ? {}
                : { workboard: { source: "path", sourcePath: workboard, installPath: workboard } },
            plugins: [],
            diagnostics: [],
          },
        }),
      );
    }
    const before = await fs.readFile(source);
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const maintenance =
      engine === "sqlite-maintenance"
        ? await acquireGatewayLock({
            env,
            role: "sqlite-maintenance",
            allowInTests: true,
            timeoutMs: 0,
          })
        : null;
    if (engine === "sqlite-maintenance") {
      expect(maintenance).not.toBeNull();
    }
    const run = () =>
      withUserPathBaseDirectory(engine === "postgres-relative" ? invocationDir : undefined, () =>
        createUpdateDatabaseBackup({
          backupRoot: path.join(root, "rollback"),
          stateDir,
          config: {
            plugins: {
              ...(engine === "postgres-relative"
                ? { load: { paths: ["./extensions/workboard"] } }
                : {}),
              entries: { workboard: { enabled: false } },
            },
          },
          env,
          stopped: engine === "sqlite",
          preserveSourceArtifacts: maintenance !== null,
        }),
      );
    try {
      const capture = maintenance ? maintenance.run(run) : run();
      if (postgres) {
        // Disabled plugin stores still need custody, before contacting PostgreSQL or taking a snapshot.
        await expect(capture).rejects.toThrow(
          "PostgreSQL update capture requires exclusive ownership",
        );
      } else {
        const backup = await capture;
        expect(backup.databases).toHaveLength(1);
        expect(backup.databases[0]?.path).toBe(source);
        using snapshot = new DatabaseSync(backup.databases[0]!.snapshotPath, { readOnly: true });
        expect(snapshot.prepare("SELECT value FROM payload").get()).toEqual({ value: "preserved" });
      }
      expect(await fs.readFile(source)).toEqual(before);
    } finally {
      await maintenance?.release();
    }
  },
);
