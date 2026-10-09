import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import * as retry from "@openclaw/retry";
import { expect, it, vi } from "vitest";
import { resolveDeferredPluginMigrationConfigPaths } from "../config/deferred-plugin-migration-config.js";
import { createConfigIO } from "../config/io.factory.js";
import { readConfigFileSnapshot } from "../config/io.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { resolveGatewayStateOwnerPath } from "../infra/gateway-state-owner.js";
import { createSqliteReadOnlyWorkerError } from "../infra/sqlite-readonly-worker-protocol.js";
import { readBundledDiscoveryMode } from "../plugins/bundled-discovery-state.js";
import { readPersistedInstalledPluginIndexRowSync } from "../plugins/test-helpers/installed-plugin-index.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
  inspectAgentDatabaseAdmission,
} from "../state/agent-database-admission.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "../state/openclaw-state-db-schema-migration-required.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { readAdmittedConfigSnapshot } from "./config-preflight-snapshot.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

it("preserves a proven schema failure from the full config snapshot", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const configPath =
      process.env.OPENCLAW_CONFIG_PATH ?? path.join(home, ".openclaw/openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { mode: "local" } }));
    const pathname = openOpenClawStateDatabase({ env: process.env }).path;
    await closeOpenClawStateDatabaseAsync();
    const database = new DatabaseSync(pathname);
    try {
      database.exec(
        "INSERT OR REPLACE INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES ('state.schema.contentVersion', '\"invalid\"', 1)",
      );
    } finally {
      database.close();
    }
    const before = fs.readFileSync(pathname);
    await expect(readConfigFileSnapshot({ observe: false })).rejects.toMatchObject({
      name: "SqliteSchemaMismatchError",
      message: expect.stringContaining("Invalid shared state schema content version"),
    });
    expect(fs.readFileSync(pathname)).toEqual(before);
  });
});

it.each([
  "SQLite inspection",
  "initial config read",
  "full config read",
  "invalid authored JSON",
  "invalid include directive",
  "inspection with offline maintenance",
  "ownership mismatch",
  "wrapped ownership mismatch",
  "aggregate ownership mismatch",
  "pending inspection",
  "failed inspection",
  "proven integrity damage",
  "unavailable integrity check",
])("preserves failed %s during startup admission", async (phase) => {
  await withDoctorConfigPreflightHome(async (home) => {
    const configPath =
      process.env.OPENCLAW_CONFIG_PATH ?? path.join(home, ".openclaw/openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { mode: "local" },
        plugins: { enabled: false },
        ...(phase === "initial config read" ? { $include: "missing.json" } : {}),
        ...(phase === "invalid include directive" ? { $include: 42 } : {}),
      }),
    );
    if (phase === "invalid authored JSON") {
      fs.writeFileSync(configPath, "{ invalid authored JSON");
    }
    const inspectionFailure = createSqliteReadOnlyWorkerError(
      "failed while creating its private snapshot",
      "",
    );
    let failure: Error =
      phase === "inspection with offline maintenance"
        ? new AggregateError(
            [
              inspectionFailure,
              new OpenClawStateDatabaseSchemaMigrationRequiredError(
                "audit-events-v2",
                "/synthetic/state.sqlite",
              ),
            ],
            "startup inspection and maintenance failed",
          )
        : inspectionFailure;
    if (phase.includes("ownership mismatch")) {
      const mismatch = new AgentDatabaseAdmissionError(
        expectDefined(
          inspectAgentDatabaseAdmission({
            agentId: "requested",
            path: "/synthetic/agent.sqlite",
            metadata: { role: "agent", agentId: "actual" },
          }),
          "Expected an ownership mismatch",
        ),
      );
      failure =
        phase === "wrapped ownership mismatch"
          ? new Error("read admission failed", { cause: mismatch })
          : phase === "aggregate ownership mismatch"
            ? new AggregateError([inspectionFailure, mismatch], "read admission failed")
            : mismatch;
    } else if (phase === "pending inspection" || phase === "failed inspection") {
      failure = new AgentDatabaseAdmissionError(
        createAgentDatabaseInspectionRefusal({
          agentId: "requested",
          paths: ["/synthetic/agent.sqlite"],
          reason: "storage unavailable",
          pending: phase === "pending inspection",
        }),
      );
    } else if (phase === "proven integrity damage" || phase === "unavailable integrity check") {
      const integrity = new Error(
        "SQLite integrity_check failed",
        phase === "unavailable integrity check"
          ? { cause: Object.assign(new Error("storage unavailable"), { code: "EIO" }) }
          : undefined,
      );
      integrity.name = "SqliteIntegrityError";
      failure = new AgentDatabaseAdmissionError(
        createAgentDatabaseInspectionRefusal({
          agentId: "requested",
          paths: ["/synthetic/agent.sqlite"],
          reason: integrity.message,
          cause: integrity,
        }),
      );
    }
    const read = readAdmittedConfigSnapshot({
      env: process.env,
      readSnapshot: async () => {
        if (phase === "full config read") {
          const reader = createConfigIO({
            configPath,
            observe: false,
            fs: {
              ...fs,
              readFileSync() {
                throw Object.assign(new Error("configuration read failed: EIO"), { code: "EIO" });
              },
            },
          });
          return { snapshot: await reader.readConfigFileSnapshot() };
        }
        throw failure;
      },
    });
    if (phase === "invalid authored JSON" || phase === "invalid include directive") {
      await expect(read).resolves.toMatchObject({
        snapshot: { valid: false, issues: [{ errorCode: "CONFIG_SOURCE_INVALID" }] },
      });
    } else if (phase === "full config read") {
      await expect(read).rejects.toMatchObject({
        code: "CONFIG_READ_FAILED",
        message: expect.stringContaining("EIO"),
      });
    } else if (phase === "initial config read") {
      await expect(read).resolves.toMatchObject({
        snapshot: {
          valid: false,
          issues: [
            { errorCode: "CONFIG_READ_FAILED", message: expect.stringContaining("missing.json") },
          ],
        },
      });
    } else if (
      phase === "inspection with offline maintenance" ||
      phase === "proven integrity damage" ||
      phase.includes("ownership mismatch")
    ) {
      await expect(read).rejects.toMatchObject({ code: 78, cause: failure });
    } else {
      await expect(read).rejects.toBe(failure);
    }
  });
});

it("waits through temporary schema custody before reading startup configuration once", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const configPath =
      process.env.OPENCLAW_CONFIG_PATH ?? path.join(home, ".openclaw/openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } }),
    );
    const databasePath = openOpenClawStateDatabase({ env: process.env }).path;
    await closeOpenClawStateDatabaseAsync();
    const before = fs.readFileSync(databasePath);
    const marker = resolveGatewayStateOwnerPath(databasePath);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(
      marker,
      JSON.stringify({
        pid: process.ppid,
        ownerId: "synthetic-schema-owner",
        createdAt: new Date().toISOString(),
        configPath,
        role: "sqlite-maintenance",
        stateOwnerKind: "schema",
      }),
    );
    const readSnapshot = vi.fn(async () => ({
      snapshot: await readConfigFileSnapshot({ observe: false, pluginValidation: "core-only" }),
    }));
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const wait = vi.spyOn(retry, "sleepWithAbort").mockImplementation(async () => {
      expect(readSnapshot).not.toHaveBeenCalled();
      expect(fs.readFileSync(databasePath)).toEqual(before);
      if (wait.mock.calls.length === 1) {
        now.mockReturnValue(9_000);
      } else {
        fs.unlinkSync(marker);
        now.mockRestore();
      }
    });
    try {
      const result = await readAdmittedConfigSnapshot({ env: process.env, readSnapshot });
      expect(result.snapshot.valid).toBe(true);
      expect(wait).toHaveBeenCalledTimes(2);
      expect(readSnapshot).toHaveBeenCalledOnce();
      expect(fs.readFileSync(databasePath)).toEqual(before);
    } finally {
      wait.mockRestore();
      now.mockRestore();
      fs.rmSync(marker, { force: true });
      await closeOpenClawStateDatabaseAsync();
    }
  });
});

it("shares startup validation and discovery reads, then releases them before readiness guards", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw");
    const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } }),
    );
    const options = { env: process.env };
    const { path: databasePath } = openOpenClawStateDatabase(options);
    await closeOpenClawStateDatabaseAsync();
    const writer = new DatabaseSync(databasePath);
    const family = () =>
      ["", "-wal", "-shm"].map((suffix) => {
        const pathname = databasePath + suffix;
        return fs.existsSync(pathname) ? fs.readFileSync(pathname) : null;
      });
    const readIndex = () =>
      readPersistedInstalledPluginIndexRowSync({ env: process.env })?.value_json;
    try {
      const insert = writer.prepare(
        "INSERT INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES (?, ?, 1)",
      );
      insert.run("plugins.bundledDiscovery", '"compat"');
      insert.run("plugins.installedIndex", '{"generation":"before"}');
      const before = family();
      let afterWrite: ReturnType<typeof family> | undefined;
      const validations: Array<string | undefined> = [];
      const result = await readAdmittedConfigSnapshot({
        env: process.env,
        validateConfig: () => {
          validations.push(readIndex());
          expect(readBundledDiscoveryMode(options)).toBe("compat");
        },
        readSnapshot: async () => {
          const snapshot = await readConfigFileSnapshot({
            observe: false,
            pluginValidation: "core-only",
          });
          expect(readBundledDiscoveryMode(options)).toBe("compat");
          expect(family()).toEqual(before);
          // A different owner commits between the two metadata reads.
          writer.exec(
            `BEGIN;
             UPDATE config_machine_state SET value_json = '"allowlist"' WHERE state_key = 'plugins.bundledDiscovery';
             UPDATE config_machine_state SET value_json = '{"generation":"after"}' WHERE state_key = 'plugins.installedIndex';
             COMMIT;`,
          );
          afterWrite = family();
          expect(readIndex()).toBe('{"generation":"before"}');
          expect(family()).toEqual(afterWrite);
          return { snapshot };
        },
        beforeStatePreparation: async () => {
          expect(readBundledDiscoveryMode(options)).toBe("allowlist");
          expect(readIndex()).toBe('{"generation":"after"}');
          return true;
        },
      });
      expect(result.snapshot.valid).toBe(true);
      expect(validations).toEqual(['{"generation":"before"}', '{"generation":"before"}']);
      expect(family()).toEqual(afterWrite);
    } finally {
      writer.close();
      closeOpenClawStateDatabaseForTest();
    }
  });
});

it("refuses a session-store change between core admission and the full config read", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw");
    const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const config = { gateway: { mode: "local" }, plugins: { enabled: false } };
    fs.writeFileSync(configPath, JSON.stringify(config));
    const legacyStore = path.join(home, "other", "sessions.json");
    fs.mkdirSync(path.dirname(legacyStore));
    fs.writeFileSync(legacyStore, "{}\n");
    const changedConfig = JSON.stringify({ ...config, session: { store: legacyStore } });

    await expect(
      readAdmittedConfigSnapshot({
        env: process.env,
        readSnapshot: async () => {
          // Simulate an operator edit while the asynchronous admission read is in flight.
          fs.writeFileSync(configPath, changedConfig);
          return {
            snapshot: await readConfigFileSnapshot({ observe: false }),
          };
        },
      }),
    ).rejects.toMatchObject({ code: 78, message: expect.stringContaining("inputs changed") });
    expect(fs.readFileSync(configPath, "utf8")).toBe(changedConfig);
    expect(fs.readFileSync(legacyStore, "utf8")).toBe("{}\n");
    expect(fs.existsSync(path.join(stateDir, "state"))).toBe(false);
  });
});

it.each([false, true])(
  "preserves pending-plugin inputs (legacy identity: %s)",
  async (legacyIdentity) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw");
      const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const source = {
        gateway: { mode: "local", port: 18991 },
        plugins: { entries: { canvas: { enabled: true } } },
        canvasHost: { enabled: true, root: path.join(home, "legacy-canvas") },
      };
      const activeRaw = `${JSON.stringify(source, null, 2)}\n`;
      const backupRaw = JSON.stringify({
        gateway: { mode: "local", port: 18789 },
        plugins: { enabled: false },
      });
      fs.writeFileSync(configPath, activeRaw);
      fs.writeFileSync(`${configPath}.bak`, backupRaw);
      const initial = await readConfigFileSnapshot({
        observe: false,
        pluginValidation: "core-only",
      });
      expect(initial.valid).toBe(false);

      await recordDeferredPluginMigrations({
        env: process.env,
        pending: [
          {
            pluginId: "canvas",
            reason: "The configured plugin is not installed.",
            command: "openclaw doctor --fix",
            ...resolveDeferredPluginMigrationConfigPaths({
              config: initial.sourceConfig,
              pluginId: "canvas",
              compatibilityMigrationPaths: ["canvasHost"],
            }),
          },
        ],
        resolvedPluginIds: [],
      });
      expect((await readConfigFileSnapshot({ observe: false })).valid).toBe(true);
      await closeOpenClawStateDatabaseAsync();
      const identityPath = path.join(stateDir, "identity", "device.json");
      const identityRaw = '{"retiredIdentity":"leave for Doctor"}\n';
      if (legacyIdentity) {
        fs.mkdirSync(path.dirname(identityPath), { recursive: true });
        fs.writeFileSync(identityPath, identityRaw);
      }
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      const databaseFamily = () =>
        ["", "-wal", "-shm"].map((suffix) => {
          const pathname = databasePath + suffix;
          return fs.existsSync(pathname) ? fs.readFileSync(pathname) : null;
        });
      const before = databaseFamily();
      if (legacyIdentity) {
        await expect(
          runStartupConfigPreflight({ gateway: true, observe: false }),
        ).rejects.toMatchObject({
          code: 78,
          message: expect.stringContaining("Legacy device identity exists"),
        });
        expect(fs.readFileSync(identityPath, "utf8")).toBe(identityRaw);
      } else {
        const result = await readAdmittedConfigSnapshot({
          env: process.env,
          readSnapshot: async () => ({
            snapshot: await readConfigFileSnapshot({ observe: false }),
          }),
        });
        expect(result.recovery).toBeUndefined();
        expect(result.snapshot.valid).toBe(true);
        expect(result.snapshot.hash).toBe(initial.hash);
        expect(result.snapshot.raw).toBe(activeRaw);
        expect(result.snapshot.sourceConfig).toMatchObject(source);
        expect(result.snapshot.config.gateway?.port).toBe(18991);
        expect(result.snapshot.config).not.toHaveProperty("canvasHost");
      }
      expect(fs.readFileSync(configPath, "utf8")).toBe(activeRaw);
      expect(fs.readFileSync(`${configPath}.bak`, "utf8")).toBe(backupRaw);
      expect(databaseFamily()).toEqual(before);
    });
  },
);
