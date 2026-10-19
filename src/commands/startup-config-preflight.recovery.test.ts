import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi, type MockInstance } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  prepareGatewayRunBootstrap,
  recheckGatewayRunBootstrap,
} from "../cli/gateway-cli/pre-bootstrap.js";
import { beginGatewayBootLifecycle } from "../infra/gateway-boot-lifecycle.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as checkpoint from "../infra/startup-migration-checkpoint.js";
import { readStartupMigrationWarning } from "../infra/state-migrations.messages.js";
import * as metadataWorker from "../plugins/plugin-metadata-state-worker.js";
import { ExitError } from "../runtime.js";
import { deleteConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { useDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import {
  runStartupConfigPreflight,
  type StartupConfigPreflightOptions,
} from "./startup-config-preflight.js";

const inPreflightHome = useDoctorConfigPreflightHome();
const backupConfig = {
  gateway: { mode: "local" },
  plugins: { enabled: false },
  meta: { migrations: { webhookListeners: true } },
};
const incompleteConfig = '{"update":{"channel":"stable"}}\n';
const runtime = {
  log() {},
  error() {},
  exit(code: number): never {
    throw new ExitError(code);
  },
};

async function withPreflightHome(
  run: (home: string, stateDir: string, configPath: string) => Promise<void>,
) {
  return inPreflightHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    await run(home, stateDir, path.join(stateDir, "openclaw.json"));
  });
}

function initializeDatabase(stateDir: string) {
  openOpenClawStateDatabase({ path: path.join(stateDir, "state", "openclaw.sqlite") });
  closeOpenClawStateDatabaseForTest();
}

async function expectLeaseReleased(
  heartbeat: MockInstance<checkpoint.StartupMigrationLease["heartbeat"]> | undefined,
) {
  expect(vi.getTimerCount()).toBe(0);
  expect(heartbeat).toBeDefined();
  heartbeat?.mockClear();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(heartbeat).not.toHaveBeenCalled();
  expect(checkpoint.hasActiveStartupMigrationLease()).toBe(false);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

it.each(["current", "webhook-repair"] as const)(
  "preserves authored config during startup from %s",
  async (source) => {
    await withPreflightHome(async (home, stateDir, configPath) => {
      const original = JSON.stringify({
        gateway: { mode: "local" },
        ...(source === "webhook-repair"
          ? {
              channels: {
                "nextcloud-talk": {
                  enabled: true,
                  baseUrl: "https://cloud.example.com",
                  botSecret: "test-bot-secret",
                },
              },
            }
          : { plugins: { enabled: false } }),
      });
      initializeDatabase(stateDir);
      if (source === "webhook-repair") {
        await beginGatewayBootLifecycle(process.env, 1_800_000_000_000);
      }
      await fs.writeFile(configPath, original);

      expect(await prepareGatewayRunBootstrap({ opts: {}, runtime })).toBe(true);
      const replacement = JSON.stringify({
        gateway: { mode: "local", port: 19002 },
        plugins: { enabled: false },
      });
      const options: StartupConfigPreflightOptions = {
        gateway: true,
        beforeStatePreparation: (snapshot) =>
          recheckGatewayRunBootstrap({ opts: {}, runtime, snapshot }),
      };
      if (source === "webhook-repair") {
        const registry = await import("../plugins/doctor-contract-registry.js");
        const applyMigrations = registry.applyPluginDoctorCompatibilityMigrations;
        const migrationReads: string[] = [];
        vi.spyOn(registry, "applyPluginDoctorCompatibilityMigrations").mockImplementation(
          (...args) => {
            const sql = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
            try {
              return applyMigrations(...args);
            } finally {
              migrationReads.push(...sql.queries);
              sql.restore();
            }
          },
        );
        await expect(runStartupConfigPreflight(options)).rejects.toMatchObject({
          code: 78,
          message: expect.stringMatching(
            /openclaw doctor --fix[\s\S]*Pinned channels\.nextcloud-talk\.accounts\.default\.legacyWebhook/,
          ),
        });
        // Startup already prepared the webhook receipt and plugin metadata.
        expect(
          migrationReads.filter((sql) => /\bfrom\s+"?config_machine_state"?/i.test(sql)),
        ).toHaveLength(0);
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
        await expect(fs.stat(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        const registry = await import("../plugins/doctor-contract-registry.js");
        const migrations = vi.spyOn(registry, "applyPluginDoctorCompatibilityMigrations");
        const reads = vi.spyOn(metadataWorker, "readPluginMetadataStateRow");
        const verificationReads: number[] = [];
        options.measure = async (name, run) => {
          if (name !== "doctor.config-preflight.plugin-plan") {
            return await run();
          }
          const before = reads.mock.calls.length;
          const value = await run();
          verificationReads.push(reads.mock.calls.length - before);
          return value;
        };
        const ready = await runStartupConfigPreflight(options);
        expect(ready.snapshot.valid).toBe(true);
        expect(readConfigMachineState(`webhookListeners:${configPath}`)).toBe(true);
        expect(verificationReads).toEqual([0]);
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
        await expect(fs.stat(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await runStartupConfigPreflight(options)).snapshot.valid).toBe(true);
        expect(migrations).toHaveBeenCalledTimes(1);
        expect(verificationReads).toEqual([0, 0]);
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
        expect(deleteConfigMachineState(`webhookListeners:${configPath}`)).toBe(true);
        expect((await runStartupConfigPreflight(options)).snapshot.valid).toBe(true);
        expect(readConfigMachineState(`webhookListeners:${configPath}`)).toBe(true);
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
        await fs.writeFile(configPath, replacement);
        await expect(runStartupConfigPreflight(options)).rejects.toMatchObject({ code: 1 });
        expect(await fs.readFile(configPath, "utf8")).toBe(replacement);
      }
      expect(checkpoint.hasActiveStartupMigrationLease()).toBe(false);
    });
  },
);

it("records no-pin completion with a read-only included config and skips it on restart", async () => {
  await withPreflightHome(async (_home, _stateDir, configPath) => {
    const includedPath = path.join(path.dirname(configPath), "included.json");
    const original = JSON.stringify({ $include: "included.json" });
    const included = JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } });
    await fs.writeFile(configPath, original);
    await fs.writeFile(includedPath, included);
    const registry = await import("../plugins/doctor-contract-registry.js");
    const migrations = vi.spyOn(registry, "applyPluginDoctorCompatibilityMigrations");
    await withEnvAsync({ OPENCLAW_CONFIG_READONLY: "1" }, async () => {
      expect((await runStartupConfigPreflight({ gateway: true })).snapshot.valid).toBe(true);
      expect(readConfigMachineState(`webhookListeners:${configPath}`)).toBe(true);
      expect(migrations).toHaveBeenCalledTimes(1);
      expect((await runStartupConfigPreflight({ gateway: true })).snapshot.valid).toBe(true);
      expect(migrations).toHaveBeenCalledTimes(1);
    });
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    expect(await fs.readFile(includedPath, "utf8")).toBe(included);
  });
});

it("keeps startup available when saving no-pin completion fails", async () => {
  await withPreflightHome(async (_home, _stateDir, configPath) => {
    const original = JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } });
    await fs.writeFile(configPath, original);
    const machineState = await import("../state/config-machine-state-async.js");
    vi.spyOn(machineState, "writeConfigMachineStateAsync").mockRejectedValue(
      new Error("completion store is read-only"),
    );
    expect((await runStartupConfigPreflight({ gateway: true })).snapshot.valid).toBe(true);
    expect(readStartupMigrationWarning()).toContain("Could not record webhook listener completion");
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
  });
});

it.each([
  ["localhost", "loopback"],
  ["0.0.0.0", "lan"],
] as const)(
  "leaves legacy bind %s untouched until Doctor repairs it",
  async (legacy, canonical) => {
    await withPreflightHome(async (home, stateDir, configPath) => {
      const original = JSON.stringify({
        gateway: { mode: "local", bind: legacy },
        plugins: { enabled: false },
      });
      await fs.writeFile(configPath, original);

      const blocked = await runStartupConfigPreflight({ gateway: true, observe: false });

      expect(blocked.snapshot.valid).toBe(false);
      expect(blocked.snapshot.legacyIssues).toContainEqual(
        expect.objectContaining({ path: "gateway.bind" }),
      );
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      expect(
        (await fs.readdir(stateDir)).filter((name) => name.startsWith("openclaw.json.")),
      ).toEqual([]);

      await runDoctorConfigPreflight({
        observe: false,
        migrateState: false,
        migrateLegacyConfig: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      });
      const ready = await runStartupConfigPreflight({ gateway: true });

      expect(ready.snapshot.valid).toBe(true);
      expect(ready.snapshot.config.gateway?.bind).toBe(canonical);
      expect(JSON.parse(await fs.readFile(configPath, "utf8")).gateway.bind).toBe(canonical);
    });
  },
);

it("restores the admitted backup after database readiness exceeds the lease TTL", async () => {
  await withPreflightHome(async (home, stateDir, configPath) => {
    const backup = backupConfig;
    await fs.writeFile(configPath, incompleteConfig);
    await fs.writeFile(`${configPath}.bak`, JSON.stringify(backup));
    initializeDatabase(stateDir);
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    let acquired: checkpoint.StartupMigrationLease | undefined;
    let heartbeats = 0;
    const acquire = checkpoint.acquireStartupMigrationLeaseWithWait;
    vi.spyOn(checkpoint, "acquireStartupMigrationLeaseWithWait").mockImplementationOnce(
      async (params) => {
        const lease = await acquire(params);
        const heartbeat = lease.heartbeat;
        vi.spyOn(lease, "heartbeat").mockImplementation((heartbeatParams) => {
          heartbeats++;
          heartbeat(heartbeatParams);
        });
        acquired = lease;
        return lease;
      },
    );
    const readiness = await import("../state/openclaw-database-preflight.js");
    const assertReady = readiness.assertOpenClawDatabasesReady;
    let delayed = false;
    vi.spyOn(readiness, "assertOpenClawDatabasesReady").mockImplementation(async (params) => {
      await assertReady(params);
      if (acquired && !delayed) {
        delayed = true;
        // Keep the real admission promise pending while interval renewals become due.
        await vi.advanceTimersByTimeAsync(checkpoint.STARTUP_MIGRATION_LEASE_TTL_MS + 60_000);
        // Authority must observe heartbeat commits beyond the preparation snapshot.
        acquired.assertOwned();
        // Subsequent plugin lease acquisition uses a worker with the real wall clock.
        vi.setSystemTime(vi.getRealSystemTime());
      }
    });

    const result = await runStartupConfigPreflight({ gateway: true });

    expect(delayed).toBe(true);
    expect(result.snapshot.valid).toBe(true);
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(backup);
    expect(checkpoint.hasActiveStartupMigrationLease()).toBe(false);
    const completedHeartbeats = heartbeats;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeats).toBe(completedHeartbeats);
  });
});

it.each(["backup", "active config"] as const)(
  "refuses changed %s under the lease before any repair",
  async (kind) => {
    await withPreflightHome(async (home, stateDir, configPath) => {
      const backup = backupConfig;
      const original = incompleteConfig;
      const replacement = JSON.stringify(
        kind === "backup"
          ? {
              ...backup,
              meta: { lastTouchedVersion: "9999.1.1" },
              env: { vars: { OPENCLAW_SERVICE_MARKER: "openclaw" } },
            }
          : {
              ...backup,
              agents: { defaults: { workspace: path.join(home, "changed-workspace") } },
            },
      );
      initializeDatabase(stateDir);
      await fs.writeFile(configPath, original);
      await fs.writeFile(`${configPath}.bak`, JSON.stringify(backup));

      await withEnvAsync(
        { OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: undefined },
        async () => {
          expect(await prepareGatewayRunBootstrap({ opts: {}, runtime })).toBe(true);
          const acquire = checkpoint.acquireStartupMigrationLeaseWithWait;
          let heartbeat: MockInstance<checkpoint.StartupMigrationLease["heartbeat"]> | undefined;
          const acquisition = vi
            .spyOn(checkpoint, "acquireStartupMigrationLeaseWithWait")
            .mockImplementationOnce(async (params) => {
              const lease = await acquire(params);
              heartbeat = vi.spyOn(lease, "heartbeat");
              // Admission observers own real timers; this clock tracks the lease heartbeat.
              vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
              await fs.writeFile(kind === "backup" ? `${configPath}.bak` : configPath, replacement);
              return lease;
            });
          const refusal = await runStartupConfigPreflight({
            gateway: true,
            beforeStatePreparation: (snapshot) =>
              recheckGatewayRunBootstrap({ opts: {}, runtime, snapshot }),
          }).catch((error: unknown) => error);
          expect(acquisition).toHaveBeenCalledTimes(1);
          await expectLeaseReleased(heartbeat);
          expect(refusal).toMatchObject({ code: kind === "backup" ? 78 : 1 });
          expect(await fs.readFile(configPath, "utf8")).toBe(
            kind === "backup" ? original : replacement,
          );
          expect(
            (await fs.readdir(stateDir)).filter((name) => name.includes(".clobbered.")),
          ).toEqual([]);
        },
      );
    });
  },
);

it.each([
  ["reacquires an expired migration lease during admission", "expired"],
  ["reacquires a reassigned migration lease during admission", "reassigned"],
  ["fails after three attempts when the lease is lost on every attempt", "always expired"],
] as const)("%s", async (_title, loss) => {
  await withPreflightHome(async (home, stateDir, configPath) => {
    const original = incompleteConfig;
    await fs.writeFile(configPath, original);
    await fs.writeFile(`${configPath}.bak`, JSON.stringify(backupConfig));
    initializeDatabase(stateDir);
    const acquire = checkpoint.acquireStartupMigrationLeaseWithWait;
    let attempts = 0;
    let heartbeat: MockInstance<checkpoint.StartupMigrationLease["heartbeat"]> | undefined;
    vi.spyOn(checkpoint, "acquireStartupMigrationLeaseWithWait").mockImplementation(
      async (params) => {
        attempts++;
        if (loss === "always expired" && attempts > 3) {
          throw new Error("Startup retried after the third lost lease.");
        }
        if (attempts > 1 && loss !== "always expired") {
          return acquire(params);
        }
        const stale = await acquire({
          ...params,
          now: () => Date.now() - checkpoint.STARTUP_MIGRATION_LEASE_TTL_MS - 1,
          timeoutMs: 0,
        });
        heartbeat = vi.spyOn(stale, "heartbeat");
        if (loss === "reassigned") {
          const replacement = await acquire({ ...params, timeoutMs: 0 });
          replacement.release();
        }
        if (!vi.isFakeTimers()) {
          vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        }
        return stale;
      },
    );
    if (loss === "always expired") {
      await expect(runStartupConfigPreflight({ gateway: true })).rejects.toBeInstanceOf(
        checkpoint.StartupMigrationLeaseLostError,
      );
      expect(attempts).toBe(3);
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      expect((await fs.readdir(stateDir)).filter((name) => name.includes(".clobbered."))).toEqual(
        [],
      );
      await expectLeaseReleased(heartbeat);
      return;
    }
    const result = await runStartupConfigPreflight({ gateway: true });
    expect(result.snapshot.valid).toBe(true);
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
      gateway: { mode: "local" },
    });
    const clobbered = (await fs.readdir(stateDir)).filter((name) => name.includes(".clobbered."));
    expect(clobbered).toHaveLength(1);
    expect(await fs.readFile(path.join(stateDir, clobbered[0]!), "utf8")).toBe(original);
    await expectLeaseReleased(heartbeat);
  });
});
