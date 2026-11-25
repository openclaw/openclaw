import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  resolveDaemonRuntimePinStorePath,
  withDaemonRuntimePinStore,
} from "../daemon/runtime-pin-store.js";
import { backupCase, restoreBackup } from "./backup-create-family.test-support.js";
import { createBackupArchive } from "./backup-create.js";

it(
  "snapshots the runtime pin store instead of archiving opaque bytes",
  backupCase({ layout: "split", prefix: "backup-runtime-pins-" })(async (state) => {
    withDaemonRuntimePinStore(state.env, true, (db) => {
      db.prepare(
        "INSERT INTO daemon_runtime_pins (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
      ).run("gateway", '{"runtimePath":"/synthetic/node"}', 123);
    });
    const pathname = resolveDaemonRuntimePinStorePath(state.env);
    const backup = await createBackupArchive({
      output: state.path("backup.tar.gz"),
      includeWorkspace: false,
    });
    expect(backup.warnings ?? []).not.toContainEqual(expect.stringContaining(pathname));
    const restored = await restoreBackup(state, backup);
    const asset = backup.assets.find((entry) => entry.kind === "state");
    expect(asset).toBeDefined();
    const restoredPath = path.join(
      restored.targetPath,
      asset!.archivePath,
      path.relative(state.statePath(), pathname),
    );
    if (process.platform !== "win32") {
      expect((await fs.stat(path.dirname(restoredPath))).mode & 0o777).toBe(0o700);
    }
    using recovered = new DatabaseSync(restoredPath, { readOnly: true });
    expect(recovered.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(
      recovered.prepare("SELECT state_key, value_json FROM daemon_runtime_pins").all(),
    ).toEqual([{ state_key: "gateway", value_json: '{"runtimePath":"/synthetic/node"}' }]);
  }),
);
