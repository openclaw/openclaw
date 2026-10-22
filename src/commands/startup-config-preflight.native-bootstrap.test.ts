import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  readMacNodeWorkerProofRows,
  seedMacNodeWorkerProofState,
} from "../../scripts/lib/mac-node-worker-proof-state.mjs";
import {
  getGatewayStartGuardErrors,
  prepareGatewayRunBootstrap,
  recheckGatewayRunBootstrap,
} from "../cli/gateway-cli/pre-bootstrap.js";
import { resolveClientCredentialStorePath } from "../infra/client-credential-paths.js";
import { hasActiveStartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { ExitError } from "../runtime.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

it.each([false, true])(
  "migrates native credentials before webhook readiness (routed root: %s)",
  async (routed) => {
    await withOpenClawTestState({ label: "gateway-native-bootstrap" }, async (state) => {
      const config = { gateway: { mode: "local" }, plugins: { enabled: false } };
      const selectedRoot = routed ? state.path("selected") : state.stateDir;
      const selectedConfig = path.join(selectedRoot, "openclaw.json");
      const selectedEnv = { ...state.env, OPENCLAW_STATE_DIR: selectedRoot };
      await state.writeConfig(config);
      let ambientDatabase: Buffer | undefined;
      if (routed) {
        seedMacNodeWorkerProofState(state.statePath("state", "openclaw.sqlite"));
        ambientDatabase = fs.readFileSync(state.statePath("state", "openclaw.sqlite"));
        fs.mkdirSync(selectedRoot);
        fs.writeFileSync(selectedConfig, JSON.stringify(config));
        await state.writeConfig({ env: { vars: { OPENCLAW_STATE_DIR: selectedRoot } } });
        delete process.env.OPENCLAW_STATE_DIR;
        delete process.env.OPENCLAW_CONFIG_PATH;
      }
      const configBefore = fs.readFileSync(selectedConfig, "utf8");
      const databasePath = path.join(selectedRoot, "state", "openclaw.sqlite");
      const nativeRows = seedMacNodeWorkerProofState(databasePath);

      const ready = await runStartupConfigPreflight({ gateway: true, observe: false });

      expect(ready.snapshot.valid).toBe(true);
      expect(ready.snapshot.path).toBe(selectedConfig);
      expect(fs.readFileSync(selectedConfig, "utf8")).toBe(configBefore);
      expect(readConfigMachineState(`webhookListeners:${selectedConfig}`)).toBe(true);
      if (routed) {
        expect(fs.readFileSync(state.statePath("state", "openclaw.sqlite"))).toEqual(
          ambientDatabase,
        );
        expect(fs.existsSync(resolveClientCredentialStorePath(state.env))).toBe(false);
      }
      await closeOpenClawStateDatabaseAsync();
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_STATE_SCHEMA_VERSION,
        );
        expect(database.prepare("SELECT boot_id FROM gateway_boot_lifecycle").all()).toEqual([]);
        expect(
          readMacNodeWorkerProofRows(database, resolveClientCredentialStorePath(selectedEnv)),
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
  },
);

it("admits the recoverable config before migrating native credentials", async () => {
  await withOpenClawTestState(
    {
      label: "gateway-native-config-recovery",
      env: { CREDENTIAL_RECOVERY_SOURCE_PROBE: undefined },
    },
    async (state) => {
      const backup = {
        gateway: { mode: "local" },
        plugins: { enabled: false },
        meta: { migrations: { webhookListeners: true } },
      };
      const original = JSON.stringify({
        update: { channel: "stable" },
        env: { vars: { CREDENTIAL_RECOVERY_SOURCE_PROBE: "clobbered-source" } },
      });
      fs.writeFileSync(state.configPath, original);
      fs.writeFileSync(`${state.configPath}.bak`, JSON.stringify(backup));
      const databasePath = state.statePath("state", "openclaw.sqlite");
      const nativeRows = seedMacNodeWorkerProofState(databasePath);
      const runtime = {
        log() {},
        error() {},
        exit(code: number): never {
          throw new ExitError(code);
        },
      };
      expect(await prepareGatewayRunBootstrap({ opts: {}, runtime })).toBe(true);

      const ready = await runStartupConfigPreflight({
        gateway: true,
        observe: false,
        validateStartupConfig: (snapshot) => {
          // Recovery discards the clobbered source's environment before credential writes.
          expect(process.env.CREDENTIAL_RECOVERY_SOURCE_PROBE).toBeUndefined();
          const errors = getGatewayStartGuardErrors({
            configExists: snapshot.exists,
            mode: snapshot.config.gateway?.mode,
          });
          if (errors.length) {
            throw new ExitError(78);
          }
        },
        beforeStatePreparation: (snapshot) =>
          recheckGatewayRunBootstrap({ opts: {}, runtime, snapshot }),
      });

      expect(ready.snapshot.valid).toBe(true);
      expect(JSON.parse(fs.readFileSync(state.configPath, "utf8"))).toEqual(backup);
      expect(fs.readFileSync(`${state.configPath}.bak`, "utf8")).toBe(JSON.stringify(backup));
      const clobbered = fs
        .readdirSync(state.stateDir)
        .filter((name) => name.includes(".clobbered."));
      expect(clobbered).toHaveLength(1);
      expect(fs.readFileSync(state.statePath(clobbered[0]!), "utf8")).toBe(original);
      expect(hasActiveStartupMigrationLease()).toBe(false);
      await closeOpenClawStateDatabaseAsync();
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_STATE_SCHEMA_VERSION,
        );
        expect(
          readMacNodeWorkerProofRows(database, resolveClientCredentialStorePath(state.env)),
        ).toEqual(nativeRows);
      } finally {
        database.close();
      }
    },
  );
});

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
      expect(fs.existsSync(resolveClientCredentialStorePath(state.env))).toBe(false);
    });
  },
);
