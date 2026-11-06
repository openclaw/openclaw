import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { seedMacNodeWorkerProofState } from "../../scripts/lib/mac-node-worker-proof-state.mjs";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { StateDatabaseOfflineMaintenanceError } from "../infra/gateway-state-owner-record.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { stateNativeProcessEntrypoints } from "../state/native-process-runtime.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
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

/** Hold state custody from another process, as a concurrent CLI or Doctor would. */
async function holdForeignStateOwner(
  databasePath: string,
  holder: "schema-lease" | "offline-maintenance",
  signal: AbortSignal,
) {
  const ownerUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.gatewayStateOwner);
  // A schema lease is the transient custody any state CLI takes (e.g. `gateway status`
  // loading the device identity). The process root is the record Doctor's
  // maintenance lock persists through acquireGatewayLock.
  const acquire =
    holder === "schema-lease"
      ? `acquireStateDatabaseSchemaLease(${JSON.stringify(databasePath)})`
      : `acquireGatewayStateOwner({ databasePath: ${JSON.stringify(databasePath)} })`;
  let readOutput = () => ({ stdout: "", stderr: "" });
  const exited = runNodeScript(
    (workerArgv) => [
      ...workerArgv(ownerUrl).slice(0, -1),
      "--input-type=module",
      "--eval",
      `const owner = await import(${JSON.stringify(ownerUrl.href)});
      const held = owner.${acquire};
      process.stdout.write("held\\n");
      ${holder === "schema-lease" ? "setTimeout(() => held.release(), 750);" : "setInterval(() => {}, 1_000);"}`,
    ],
    process.env,
    30_000,
    {
      signal,
      onReady(_child, read) {
        readOutput = read;
      },
    },
  ).catch(() => undefined);
  const deadline = performance.now() + 20_000;
  while (!readOutput().stdout.includes("held")) {
    if (performance.now() > deadline) {
      throw new Error(`Foreign state owner never held custody: ${readOutput().stderr}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  return { exited };
}

it.each(["schema-lease", "offline-maintenance"] as const)(
  "handles a foreign %s held after Gateway read admission",
  async (holder) => {
    await withOpenClawTestState({ label: `gateway-foreign-${holder}` }, async (state) => {
      await state.writeConfig({ gateway: { mode: "local" }, plugins: { enabled: false } });
      const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
      await closeOpenClawStateDatabaseAsync();
      const stop = new AbortController();
      let foreignOwner: Promise<unknown> | undefined;
      let preparations = 0;
      const ready = runStartupConfigPreflight({
        gateway: true,
        observe: false,
        // The second preparation runs after read admission, right before native bootstrap.
        beforeStatePreparation: async () => {
          if (++preparations === 2) {
            foreignOwner = (await holdForeignStateOwner(databasePath, holder, stop.signal)).exited;
          }
          return true;
        },
      });
      try {
        if (holder === "schema-lease") {
          await expect(ready).resolves.toMatchObject({ snapshot: { valid: true } });
        } else {
          await expect(ready).rejects.toBeInstanceOf(StateDatabaseOfflineMaintenanceError);
        }
        expect(foreignOwner).toBeDefined();
      } finally {
        stop.abort();
        await foreignOwner;
        await closeOpenClawStateDatabaseAsync();
      }
    });
  },
);

it.each(["invalid config", "rejected guard"] as const)(
  "preserves pending native credentials before startup admission for %s",
  async (refusal) => {
    await withOpenClawTestState({ label: "gateway-native-admission" }, async (state) => {
      await state.writeConfig({ gateway: { mode: "local" }, plugins: { enabled: false } });
      const databasePath = state.statePath("state", "openclaw.sqlite");
      seedMacNodeWorkerProofState(databasePath);
      const databaseBefore = fs.readFileSync(databasePath);
      if (refusal === "invalid config") {
        fs.writeFileSync(state.configPath, "{ invalid source");
        const ready = await runStartupConfigPreflight({ gateway: true, observe: false });
        expect(ready.snapshot.valid).toBe(false);
        expect(fs.readFileSync(state.configPath, "utf8")).toBe("{ invalid source");
      } else {
        await expect(
          runStartupConfigPreflight({
            gateway: true,
            observe: false,
            beforeStatePreparation: async () => false,
          }),
        ).rejects.toThrow("selected config changed during startup");
      }
      expect(fs.readFileSync(databasePath)).toEqual(databaseBefore);
    });
  },
);
