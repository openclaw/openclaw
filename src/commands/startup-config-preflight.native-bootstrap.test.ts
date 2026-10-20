import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  readMacNodeWorkerProofRows,
  seedMacNodeWorkerProofState,
} from "../../scripts/lib/mac-node-worker-proof-state.mjs";
import { resolveClientCredentialStorePath } from "../infra/client-credential-paths.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  prepareOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

it("starts native first-use state after captured Doctor migration before webhook readiness", async () => {
  await withOpenClawTestState({ label: "gateway-native-bootstrap" }, async (state) => {
    await state.writeConfig({ gateway: { mode: "local" }, plugins: { enabled: false } });
    const configBefore = fs.readFileSync(state.configPath, "utf8");
    const databasePath = path.join(state.stateDir, "state", "openclaw.sqlite");
    const nativeRows = seedMacNodeWorkerProofState(databasePath);
    const maintenance = await beginDoctorMaintenance({
      root: null,
      options: { repair: true, nonInteractive: true },
      runtime: { log() {}, error() {}, exit() {} },
    });
    expect(maintenance).toBeDefined();
    try {
      const migrated = await maintenance!.run(() =>
        prepareOpenClawStateDatabaseSchema({ env: state.env }, "doctor"),
      );
      expect(migrated.warnings).toEqual([]);
    } finally {
      await maintenance!.release();
    }

    const ready = await runStartupConfigPreflight({ gateway: true, observe: false });

    expect(ready.snapshot.valid).toBe(true);
    expect(fs.readFileSync(state.configPath, "utf8")).toBe(configBefore);
    expect(readConfigMachineState(`webhookListeners:${state.configPath}`)).toBe(true);
    await closeOpenClawStateDatabaseAsync();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect(database.prepare("SELECT boot_id FROM gateway_boot_lifecycle").all()).toEqual([]);
      expect(
        readMacNodeWorkerProofRows(database, resolveClientCredentialStorePath(state.env)),
      ).toEqual(nativeRows);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name IN ('device_identities', 'device_auth_tokens', 'gateway_origin_device_tokens')",
          )
          .all(),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });
});
