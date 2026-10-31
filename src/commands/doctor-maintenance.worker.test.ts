import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeHookRelayBridgeRecord } from "../agents/harness/native-hook-relay-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

async function loadFixtureGraph() {
  return {
    write: (await import("../agents/harness/native-hook-relay-store.js"))
      .writeNativeHookRelayBridgeRecord,
    cron: await import("../cron/store.js"),
    lock: (await import("../infra/file-lock.js")).acquireFileLock,
    gatewayLock: await import("../infra/gateway-lock.js"),
    migrate: (await import("../infra/state-migrations.state-dir.js")).autoMigrateLegacyStateDir,
    updateState: await import("../infra/update-candidate-state.js"),
    generations: (await import("../infra/update-physical-database-generations.js"))
      .readUpdatePhysicalDatabaseGenerations,
    close: (await import("../state/openclaw-state-db-cache.js")).closeOpenClawStateDatabaseAsync,
    version: (await import("../state/openclaw-state-db-contract.js")).OPENCLAW_STATE_SCHEMA_VERSION,
    open: (await import("../state/openclaw-state-db.js")).openOpenClawStateDatabase,
    statePath: (await import("../state/openclaw-state-db.paths.js")).resolveOpenClawStateSqlitePath,
    legacyTables: (await import("../state/openclaw-state-schema.test-support.js"))
      .addPreCutoverClientCredentialTablesForTest,
    context: (await import("../state/openclaw-state-worker-context.js"))
      .captureOpenClawStateWorkerContext,
    execute: (await import("../state/openclaw-state-worker-store.js")).executeOpenClawStateWorker,
    withEnv: (await import("../test-utils/env.js")).withEnvAsync,
    withState: (await import("../test-utils/openclaw-test-state.js")).withOpenClawTestState,
    heartbeat: (await import("./doctor-heartbeat-retirement.js"))
      .maybeMigrateHeartbeatCadenceToCron,
    begin: (await import("./doctor-maintenance.js")).beginDoctorMaintenance,
  };
}
let api = await loadFixtureGraph();
async function reloadStateDirFixtureGraph() {
  await api.close();
  vi.resetModules();
  api = await loadFixtureGraph();
}

function relayRecord(revision: number): NativeHookRelayBridgeRecord {
  return {
    relayId: "doctor",
    pid: revision,
    hostname: "127.0.0.1",
    port: 18789,
    token: "synthetic-doctor-worker-token",
    expiresAtMs: 20000,
  };
}

const maintenanceOptions = {
  options: { repair: true, nonInteractive: true },
  root: null,
  runtime: { log() {}, error() {}, exit() {} },
};
const implicitStateEnv = {
  OPENCLAW_HOME: undefined,
  OPENCLAW_STATE_DIR: undefined,
  OPENCLAW_CONFIG_PATH: undefined,
};
function readRelay() {
  return api.execute(api.context(), {
    type: "nativeHookRelay.read",
    input: { relayId: "doctor" },
  });
}

function claimHistoricalProjection(stateDir: string) {
  const { stateLockPath } = api.gatewayLock.resolveGatewayLockPaths({
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
  });
  // Shipped Gateways know this exclusive sidecar, not the newer root lock.
  const descriptor = fs.openSync(stateLockPath, "wx", 0o600);
  fs.closeSync(descriptor);
  fs.unlinkSync(stateLockPath);
}

afterEach(async () => {
  await api.close();
  vi.restoreAllMocks();
});

describe("Doctor maintenance with shared-state workers", () => {
  it.each(["new-root", "symlink"] as const)(
    "refuses changed legacy admission (%s)",
    async (kind) => {
      await reloadStateDirFixtureGraph();
      await api.withState({ layout: "home", scenario: "external-service" }, async (state) => {
        const legacy = path.join(state.home, ".clawdbot");
        const source = kind === "symlink" ? path.join(state.home, "retained-state") : legacy;
        fs.renameSync(state.stateDir, source);
        const original = fs.statSync(source, { bigint: true });
        if (kind === "symlink") {
          fs.symlinkSync(source, legacy, process.platform === "win32" ? "junction" : "dir");
        }
        await api.withEnv(implicitStateEnv, async () => {
          await expect(
            api.begin({
              ...maintenanceOptions,
              ...(kind === "new-root"
                ? {
                    beforeStateMutation: async () => {
                      fs.mkdirSync(state.stateDir);
                      fs.writeFileSync(path.join(state.stateDir, "independent-state"), "keep");
                    },
                  }
                : {}),
            }),
          ).rejects.toThrow(
            kind === "new-root"
              ? "State directory selection changed"
              : "Legacy state path is not a directory",
          );
          expect(fs.statSync(source, { bigint: true }).ino).toBe(original.ino);
          if (kind === "new-root") {
            expect(fs.readdirSync(state.stateDir)).toEqual(["independent-state"]);
            expect(fs.readFileSync(path.join(state.stateDir, "independent-state"), "utf8")).toBe(
              "keep",
            );
          } else {
            expect(fs.existsSync(state.stateDir)).toBe(false);
            expect(fs.realpathSync(legacy)).toBe(fs.realpathSync(source));
          }
        });
      });
    },
  );
  it.each(["resident-worker", "historical-contender", "receipt-unchanged"] as const)(
    "drains and reacquires maintenance around implicit legacy-root relocation: %s",
    async (scenario) => {
      await reloadStateDirFixtureGraph();
      await api.withState(
        { layout: "home", scenario: "external-service", label: "doctor-legacy-root" },
        async (state) => {
          const { db } = api.open();
          const version = api.version - (scenario === "resident-worker" ? 0 : 1);
          if (version < api.version) {
            api.legacyTables(db);
          }
          db.exec(`
          PRAGMA user_version = ${version};
          UPDATE schema_meta SET schema_version = ${version}
            WHERE meta_key = 'primary';
          DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion';
          INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
            VALUES ('doctor-relocation-sentinel', '{"keep":true}', 1);
        `);
          await api.close();
          const legacy = path.join(state.home, ".clawdbot");
          fs.renameSync(state.stateDir, legacy);
          if (scenario === "resident-worker") {
            await api.withEnv(
              {
                OPENCLAW_STATE_DIR: legacy,
                OPENCLAW_CONFIG_PATH: path.join(legacy, "openclaw.json"),
              },
              async () => {
                await api.write({ record: relayRecord(1), updatedAtMs: 1 });
              },
            );
          }
          await api.withEnv(
            {
              ...implicitStateEnv,
              OPENCLAW_TEST_FAST: "0",
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            },
            async () => {
              const databasePath = path.join(legacy, "state", "openclaw.sqlite");
              const databaseGenerations = scenario.startsWith("receipt-")
                ? await api.generations([databasePath])
                : undefined;
              if (databaseGenerations) {
                vi.spyOn(
                  api.updateState,
                  "readUpdateDatabaseGenerationPairIsolated",
                ).mockImplementation(async (paths) => {
                  const generations = await api.generations(paths);
                  return {
                    committed: generations,
                    physical: generations,
                    emptyReaderAlternates: {},
                  };
                });
              }
              const admittedGenerations = databaseGenerations
                ? await api.generations([databasePath])
                : undefined;
              const log = vi.fn();
              const maintenance = await api.begin({
                ...maintenanceOptions,
                runtime: { log, error() {}, exit() {} },
                databaseGenerations,
              });
              try {
                await maintenance!.run(async () => {
                  await api.migrate({ env: process.env });
                  const migrated = api.open();
                  expect(migrated.db.prepare("PRAGMA user_version").get()).toEqual({
                    user_version: api.version,
                  });
                  expect(
                    migrated.db
                      .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
                      .get("doctor-relocation-sentinel"),
                  ).toEqual({ value_json: '{"keep":true}' });
                  expect(log).toHaveBeenCalledWith(`State dir: ${legacy} → ${state.stateDir}`);
                  expect(fs.existsSync(legacy)).toBe(false);
                  if (scenario === "resident-worker") {
                    expect(await readRelay()).toEqual(relayRecord(1));
                  }
                  if (scenario === "historical-contender") {
                    expect(() => claimHistoricalProjection(state.stateDir)).toThrow(/EEXIST/);
                    await api.write({
                      record: relayRecord(2),
                      updatedAtMs: 2,
                    });
                    expect(await readRelay()).toEqual(relayRecord(2));
                    expect(() => claimHistoricalProjection(state.stateDir)).toThrow(/EEXIST/);
                  }
                });
              } finally {
                await maintenance?.release();
              }
              if (scenario === "historical-contender") {
                expect(() => claimHistoricalProjection(state.stateDir)).not.toThrow();
                expect(await readRelay()).toEqual(relayRecord(2));
              }
              if (databaseGenerations) {
                // The published updater retains old path keys; relocation must not certify
                // their missing generations as eligible for automatic restoration.
                expect(maintenance!.databaseWrites).toEqual({
                  unchanged: false,
                  fromGenerations: admittedGenerations,
                  generations: await api.generations([databasePath]),
                });
                expect(maintenance!.databaseWrites?.generations[databasePath]).not.toBe(
                  databaseGenerations[databasePath],
                );
              }
            },
          );
        },
      );
    },
  );
  it("completes writes and drainage with a resident worker after module reload", async () => {
    await api.withState(
      { scenario: "external-service", label: "doctor-managed-worker" },
      async () => {
        api.open();
        await readRelay();
        await api.close();
        vi.resetModules();
        const [doctor, worker, contexts, relay] = await Promise.all([
          import("./doctor-maintenance.js"),
          import("../state/openclaw-state-worker-store.js"),
          import("../state/openclaw-state-worker-context.js"),
          import("../agents/harness/native-hook-relay-store.js"),
        ]);
        const execute = worker.executeOpenClawStateWorker;
        const write = relay.writeNativeHookRelayBridgeRecord;
        const read = () =>
          execute(contexts.captureOpenClawStateWorkerContext(), {
            type: "nativeHookRelay.read",
            input: { relayId: "doctor" },
          });
        const maintenance = await doctor.beginDoctorMaintenance(maintenanceOptions);
        const record = relayRecord(1);
        try {
          await maintenance!.run(async () => {
            await write({ record, updatedAtMs: 1 });
            expect(await read()).toEqual(record);
          });
        } finally {
          await maintenance?.release();
        }
        await api.close();
        expect(await read()).toEqual(record);
        const successor = relayRecord(2);
        await write({ record: successor, updatedAtMs: 2 });
        expect(await read()).toEqual(successor);
      },
    );
  });
});

it("releases cron custody before Doctor finishes, without waiting for CLI cleanup", async () => {
  await api.withState(
    { scenario: "external-service", label: "doctor-cron-custody" },
    async (state) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: { heartbeat: { every: "30m" } } } },
      };
      await state.writeConfig(cfg);
      const maintenance = await api.begin(maintenanceOptions);
      try {
        const result = await maintenance!.run(() =>
          api.heartbeat({ cfg, shouldRepair: true, env: state.env }),
        );
        expect(result.warnings).toEqual([]);
        expect(result.changes).toHaveLength(1);
      } finally {
        await maintenance!.finish(cfg);
      }
      // A successor must acquire custody while the Doctor process is still alive.
      const successor = await api.lock(`${api.statePath(state.env)}.cron-authority`, {
        retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 },
        stale: 0,
        staleRecovery: "remove-if-definitely-stale",
      });
      await successor.release();
      const jobs = await api.cron.loadCronStore(
        api.cron.resolveCronJobsStorePathFromConfig(cfg, state.env),
      );
      expect(jobs.jobs).toHaveLength(1);
      expect(jobs.jobs[0]?.payload.kind).toBe("agentTurn");
    },
  );
});
