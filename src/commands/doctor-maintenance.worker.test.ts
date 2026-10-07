import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  writeNativeHookRelayBridgeRecord,
  type NativeHookRelayBridgeRecord,
} from "../agents/harness/native-hook-relay-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadCronStore, resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { acquireFileLock } from "../infra/file-lock.js";
import * as gatewayLock from "../infra/gateway-lock.js";
import {
  autoMigrateLegacyStateDir,
  resetAutoMigrateLegacyStateDirForTest,
} from "../infra/state-migrations.state-dir.js";
import * as updateState from "../infra/update-candidate-state.js";
import { readUpdateDatabaseGenerations } from "../infra/update-database-generations.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { maybeMigrateHeartbeatCadenceToCron } from "./doctor-heartbeat-cadence-migration.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

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

function claimHistoricalProjection(stateDir: string) {
  const { stateLockPath } = gatewayLock.resolveGatewayLockPaths({
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
  });
  // Shipped Gateways know this exclusive sidecar, not the newer root lock.
  const descriptor = fs.openSync(stateLockPath, "wx", 0o600);
  fs.closeSync(descriptor);
  fs.unlinkSync(stateLockPath);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  resetAutoMigrateLegacyStateDirForTest();
});

describe("Doctor maintenance with shared-state workers", () => {
  it("refuses a canonical root created after legacy maintenance admission", async () => {
    await withOpenClawTestState(
      { layout: "home", scenario: "external-service", label: "doctor-legacy-target-race" },
      async (state) => {
        const legacy = path.join(state.home, ".clawdbot");
        fs.renameSync(state.stateDir, legacy);
        const original = fs.statSync(legacy, { bigint: true });
        await withEnvAsync(
          {
            OPENCLAW_HOME: undefined,
            OPENCLAW_STATE_DIR: undefined,
            OPENCLAW_CONFIG_PATH: undefined,
          },
          async () => {
            await expect(
              beginDoctorMaintenance({
                options: { repair: true, nonInteractive: true },
                root: null,
                runtime: { log() {}, error() {}, exit() {} },
                beforeStateMutation: async () => {
                  fs.mkdirSync(state.stateDir);
                  fs.writeFileSync(path.join(state.stateDir, "independent-state"), "keep");
                },
              }),
            ).rejects.toThrow("State directory selection changed");
            expect(fs.statSync(legacy, { bigint: true }).ino).toBe(original.ino);
            expect(fs.readdirSync(state.stateDir)).toEqual(["independent-state"]);
            expect(fs.readFileSync(path.join(state.stateDir, "independent-state"), "utf8")).toBe(
              "keep",
            );
          },
        );
      },
    );
  });
  it("refuses a legacy symlink before creating the canonical state root", async () => {
    await withOpenClawTestState(
      { layout: "home", scenario: "external-service", label: "doctor-legacy-symlink" },
      async (state) => {
        const retained = path.join(state.home, "retained-state");
        const legacy = path.join(state.home, ".clawdbot");
        fs.renameSync(state.stateDir, retained);
        fs.symlinkSync(retained, legacy, process.platform === "win32" ? "junction" : "dir");
        await withEnvAsync(
          {
            OPENCLAW_HOME: undefined,
            OPENCLAW_STATE_DIR: undefined,
            OPENCLAW_CONFIG_PATH: undefined,
          },
          async () => {
            await expect(
              beginDoctorMaintenance({
                options: { repair: true, nonInteractive: true },
                root: null,
                runtime: { log() {}, error() {}, exit() {} },
              }),
            ).rejects.toThrow("Legacy state path is not a directory");
            expect(fs.existsSync(state.stateDir)).toBe(false);
            expect(fs.realpathSync(legacy)).toBe(fs.realpathSync(retained));
          },
        );
      },
    );
  });
  it.each([
    "schema-upgrade",
    "resident-worker",
    "historical-contender",
    "receipt-unchanged",
    "receipt-changed",
  ] as const)(
    "drains and reacquires maintenance around implicit legacy-root relocation: %s",
    async (scenario) => {
      await withOpenClawTestState(
        { layout: "home", scenario: "external-service", label: "doctor-legacy-root" },
        async (state) => {
          const { db } = openOpenClawStateDatabase();
          const version = OPENCLAW_STATE_SCHEMA_VERSION - (scenario === "resident-worker" ? 0 : 1);
          db.exec(`
          PRAGMA user_version = ${version};
          UPDATE schema_meta SET schema_version = ${version}
            WHERE meta_key = 'primary';
          DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion';
          INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
            VALUES ('doctor-relocation-sentinel', '{"keep":true}', 1);
        `);
          await closeOpenClawStateDatabaseAsync();
          const legacy = path.join(state.home, ".clawdbot");
          fs.renameSync(state.stateDir, legacy);
          if (scenario === "resident-worker") {
            await withEnvAsync(
              {
                OPENCLAW_STATE_DIR: legacy,
                OPENCLAW_CONFIG_PATH: path.join(legacy, "openclaw.json"),
              },
              async () => {
                await writeNativeHookRelayBridgeRecord({ record: relayRecord(1), updatedAtMs: 1 });
              },
            );
          }
          await withEnvAsync(
            {
              OPENCLAW_STATE_DIR: undefined,
              OPENCLAW_HOME: undefined,
              OPENCLAW_CONFIG_PATH: undefined,
              OPENCLAW_TEST_FAST: "0",
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            },
            async () => {
              const databasePath = path.join(legacy, "state", "openclaw.sqlite");
              const databaseGenerations = scenario.startsWith("receipt-")
                ? readUpdateDatabaseGenerations([databasePath])
                : undefined;
              if (databaseGenerations) {
                vi.spyOn(updateState, "readUpdateDatabaseGenerationsIsolated").mockImplementation(
                  async (paths) => readUpdateDatabaseGenerations(paths),
                );
                if (scenario === "receipt-changed") {
                  const beforeAdmission = new DatabaseSync(databasePath);
                  beforeAdmission.exec(
                    "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES ('outside', '{}', 2)",
                  );
                  beforeAdmission.close();
                }
              }
              const admittedGenerations = databaseGenerations
                ? readUpdateDatabaseGenerations([databasePath])
                : undefined;
              const log = vi.fn();
              const maintenance = await beginDoctorMaintenance({
                options: { repair: true, nonInteractive: true },
                root: null,
                runtime: { log, error() {}, exit() {} },
                databaseGenerations,
              });
              try {
                await maintenance!.run(async () => {
                  await autoMigrateLegacyStateDir({ env: process.env });
                  const migrated = openOpenClawStateDatabase();
                  expect(migrated.db.prepare("PRAGMA user_version").get()).toEqual({
                    user_version: OPENCLAW_STATE_SCHEMA_VERSION,
                  });
                  expect(
                    migrated.db
                      .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
                      .get("doctor-relocation-sentinel"),
                  ).toEqual({ value_json: '{"keep":true}' });
                  expect(log).toHaveBeenCalledWith(`State dir: ${legacy} → ${state.stateDir}`);
                  expect(fs.existsSync(legacy)).toBe(false);
                  if (scenario === "resident-worker") {
                    expect(
                      await executeOpenClawStateWorker(captureOpenClawStateWorkerContext(), {
                        type: "nativeHookRelay.read",
                        input: { relayId: "doctor" },
                      }),
                    ).toEqual(relayRecord(1));
                  }
                  if (scenario === "historical-contender") {
                    expect(() => claimHistoricalProjection(state.stateDir)).toThrow(/EEXIST/);
                    await writeNativeHookRelayBridgeRecord({
                      record: relayRecord(2),
                      updatedAtMs: 2,
                    });
                    expect(
                      await executeOpenClawStateWorker(captureOpenClawStateWorkerContext(), {
                        type: "nativeHookRelay.read",
                        input: { relayId: "doctor" },
                      }),
                    ).toEqual(relayRecord(2));
                    expect(() => claimHistoricalProjection(state.stateDir)).toThrow(/EEXIST/);
                  }
                });
              } finally {
                await maintenance?.release();
              }
              if (scenario === "historical-contender") {
                expect(() => claimHistoricalProjection(state.stateDir)).not.toThrow();
                expect(
                  await executeOpenClawStateWorker(captureOpenClawStateWorkerContext(), {
                    type: "nativeHookRelay.read",
                    input: { relayId: "doctor" },
                  }),
                ).toEqual(relayRecord(2));
              }
              if (databaseGenerations) {
                // The published updater retains old path keys; relocation must not certify
                // their missing generations as eligible for automatic restoration.
                expect(maintenance!.databaseWrites).toEqual({
                  unchanged: false,
                  fromGenerations: admittedGenerations,
                  generations: readUpdateDatabaseGenerations([databasePath]),
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
  it.each([
    { alreadyOpen: false, reload: false },
    { alreadyOpen: true, reload: false },
    { alreadyOpen: true, reload: true },
  ])(
    "completes writes and drainage with an already-open worker=$alreadyOpen after module reload=$reload",
    async ({ alreadyOpen, reload }) => {
      await withOpenClawTestState(
        { scenario: "external-service", label: "doctor-managed-worker" },
        async () => {
          openOpenClawStateDatabase();
          let execute = executeOpenClawStateWorker;
          let capture = captureOpenClawStateWorkerContext;
          let write = writeNativeHookRelayBridgeRecord;
          if (alreadyOpen) {
            await execute(capture(), {
              type: "nativeHookRelay.read",
              input: { relayId: "doctor" },
            });
          }
          let enterMaintenance = beginDoctorMaintenance;
          if (reload) {
            await closeOpenClawStateDatabaseAsync();
            vi.resetModules();
            const [doctor, worker, contexts, relay] = await Promise.all([
              import("./doctor-maintenance.js"),
              import("../state/openclaw-state-worker-store.js"),
              import("../state/openclaw-state-worker-context.js"),
              import("../agents/harness/native-hook-relay-store.js"),
            ]);
            enterMaintenance = doctor.beginDoctorMaintenance;
            execute = worker.executeOpenClawStateWorker;
            capture = contexts.captureOpenClawStateWorkerContext;
            write = relay.writeNativeHookRelayBridgeRecord;
          }
          const maintenance = await enterMaintenance({
            options: { repair: true, nonInteractive: true },
            root: null,
            runtime: { log() {}, error() {}, exit() {} },
          });
          const record = relayRecord(1);
          try {
            await maintenance!.run(async () => {
              await write({ record, updatedAtMs: 1 });
              expect(
                await execute(capture(), {
                  type: "nativeHookRelay.read",
                  input: { relayId: record.relayId },
                }),
              ).toEqual(record);
            });
          } finally {
            await maintenance?.release();
          }
          await closeOpenClawStateDatabaseAsync();
          expect(
            await execute(capture(), {
              type: "nativeHookRelay.read",
              input: { relayId: record.relayId },
            }),
          ).toEqual(record);
          const successor = relayRecord(2);
          await write({ record: successor, updatedAtMs: 2 });
          expect(
            await execute(capture(), {
              type: "nativeHookRelay.read",
              input: { relayId: record.relayId },
            }),
          ).toEqual(successor);
        },
      );
    },
  );
});

it("releases cron custody before Doctor finishes, without waiting for CLI cleanup", async () => {
  await withOpenClawTestState(
    { scenario: "external-service", label: "doctor-cron-custody" },
    async (state) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: { heartbeat: { every: "30m" } } } },
      };
      await state.writeConfig(cfg);
      const maintenance = await beginDoctorMaintenance({
        options: { repair: true, nonInteractive: true },
        root: null,
        runtime: { log() {}, error() {}, exit() {} },
      });
      try {
        const result = await maintenance!.run(() =>
          maybeMigrateHeartbeatCadenceToCron({ cfg, shouldRepair: true, env: state.env }),
        );
        expect(result.warnings).toEqual([]);
        expect(result.changes).toHaveLength(1);
      } finally {
        await maintenance!.finish(cfg);
      }
      // A successor must acquire custody while the Doctor process is still alive.
      const successor = await acquireFileLock(
        `${resolveOpenClawStateSqlitePath(state.env)}.cron-authority`,
        {
          retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 },
          stale: 0,
          staleRecovery: "remove-if-definitely-stale",
        },
      );
      await successor.release();
      const jobs = await loadCronStore(resolveCronJobsStorePathFromConfig(cfg, state.env));
      expect(jobs.jobs).toHaveLength(1);
      expect(jobs.jobs[0]?.payload.kind).toBe("agentTurn");
    },
  );
});
