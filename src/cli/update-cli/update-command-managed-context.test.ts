import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { removePreparedWorkerOwnershipColumns } from "../../state/openclaw-state-schema-v17.test-support.js";
import { captureOwnedManagedUpdateContext } from "./update-command-managed-context.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

it("captures the service's config without migrating its older target database", async () => {
  const home = dirs.make("openclaw-update-managed-context-");
  const stateDir = path.join(home, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const serviceEnv = {
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
  };
  const filename = openOpenClawStateDatabase({ env: serviceEnv }).path;
  closeOpenClawStateDatabaseForTest();
  fs.writeFileSync(configPath, JSON.stringify({ gateway: { mode: "local", port: 19765 } }));
  const db = new DatabaseSync(filename);
  try {
    removePreparedWorkerOwnershipColumns(db);
    db.exec(
      "PRAGMA user_version=16; UPDATE schema_meta SET schema_version=16, app_version='2026.9.2'",
    );
    const beforeSchema = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
    const beforeMeta = db.prepare("SELECT * FROM schema_meta").all();
    const beforeEnv = { ...process.env };
    const stopState: PreManagedServiceStop = {
      stopped: true,
      inspected: true,
      runtimeInspected: true,
      running: false,
      serviceEnv,
      serviceUpdateVerdict: {
        kind: "owned",
        root: home,
        fingerprint: "owned-service",
        refreshDefinition: false,
      },
    };

    const context = await captureOwnedManagedUpdateContext({
      stopState,
      processEnv: {
        ...process.env,
        OPENCLAW_STATE_DIR: path.join(home, "caller-state"),
        OPENCLAW_CONFIG_PATH: path.join(home, "caller.json"),
      },
    });

    expect(context?.configSnapshot.path).toBe(configPath);
    expect(context?.configSnapshot.config.gateway?.port).toBe(19765);
    expect(context?.env.OPENCLAW_STATE_DIR).toBe(stateDir);
    expect(stopState.serviceEnv).toBe(context?.env);
    expect(Object.keys(process.env).toSorted()).toEqual(Object.keys(beforeEnv).toSorted());
    for (const key of Object.keys(beforeEnv)) {
      expect(process.env[key] === beforeEnv[key], key).toBe(true);
    }
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 16 });
    expect(db.prepare("SELECT * FROM schema_meta").all()).toEqual(beforeMeta);
    expect(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(beforeSchema);
  } finally {
    db.close();
  }
});
