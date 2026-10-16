import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { seedMacNodeWorkerProofState } from "../../scripts/lib/mac-node-worker-proof-state.mjs";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

it("completes native first-use state before webhook readiness on the first Gateway attempt", async () => {
  await withOpenClawTestState({ label: "gateway-native-bootstrap" }, async (state) => {
    await state.writeConfig({ gateway: { mode: "local" }, plugins: { enabled: false } });
    const configBefore = fs.readFileSync(state.configPath, "utf8");
    const databasePath = path.join(state.stateDir, "state", "openclaw.sqlite");
    seedMacNodeWorkerProofState(databasePath);

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
      expect(database.prepare("SELECT device_id FROM device_identities").all()).toEqual([
        { device_id: "synthetic-native-device" },
      ]);
    } finally {
      database.close();
    }
  });
});
