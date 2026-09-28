import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  writeNativeHookRelayBridgeRecord,
  type NativeHookRelayBridgeRecord,
} from "../agents/harness/native-hook-relay-store.js";
import { hasErrnoCode } from "../infra/errno.js";
import * as gatewayLock from "../infra/gateway-lock.js";
import {
  acquireGatewayStateOwner,
  GatewayStateOwnerContentionError,
} from "../infra/gateway-state-owner.js";
import {
  autoMigrateLegacyStateDir,
  resetAutoMigrateLegacyStateDirForTest,
} from "../infra/state-migrations.state-dir.js";
import * as updateState from "../infra/update-candidate-state.js";
import { readUpdateDatabaseGenerations } from "../infra/update-database-generations.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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
  it.each([
    "schema-upgrade",
    "resident-worker",
    "link-rollback",
    "handoff-contender",
    "historical-contender",
    "receipt-unchanged",
    "receipt-changed",
  ] as const)(
    "retains maintenance custody through implicit legacy-root relocation: %s",
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
          await withEnvAsync(
            {
              OPENCLAW_STATE_DIR: "",
              OPENCLAW_CONFIG_PATH: path.join(legacy, "openclaw.json"),
              OPENCLAW_TEST_FAST: "0",
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            },
            async () => {
              if (scenario === "resident-worker") {
                await writeNativeHookRelayBridgeRecord({ record: relayRecord(1), updatedAtMs: 1 });
              }
              if (scenario === "link-rollback") {
                const symlink = fs.symlinkSync;
                vi.spyOn(fs, "symlinkSync").mockImplementation((target, destination, type) => {
                  if (String(destination) === legacy) {
                    throw new Error("fixture legacy alias unavailable");
                  }
                  return symlink(target, destination, type);
                });
              }
              let contenderRefused = false;
              if (scenario.endsWith("-contender")) {
                const acquire = gatewayLock.acquireGatewayLock;
                let observing = false;
                vi.spyOn(gatewayLock, "acquireGatewayLock").mockImplementation(async (options) => {
                  const held = await acquire(options);
                  if (held && !observing) {
                    observing = true;
                    const release = held.release;
                    held.release = async () => {
                      await release();
                      try {
                        if (scenario === "historical-contender") {
                          claimHistoricalProjection(state.stateDir);
                        } else {
                          const contender = acquireGatewayStateOwner({
                            databasePath: path.join(state.stateDir, "state", "openclaw.sqlite"),
                          });
                          contender.release();
                        }
                      } catch (error) {
                        if (
                          !(error instanceof GatewayStateOwnerContentionError) &&
                          !hasErrnoCode(error, "EEXIST")
                        ) {
                          throw error;
                        }
                        contenderRefused = true;
                      }
                    };
                  }
                  return held;
                });
              }
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
              const log = vi.fn();
              const maintenance = await beginDoctorMaintenance({
                options: { repair: true, nonInteractive: true },
                root: null,
                runtime: { log, error() {}, exit() {} },
                databaseGenerations,
              });
              try {
                if (scenario.endsWith("-contender")) {
                  expect(contenderRefused).toBe(true);
                }
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
                  if (scenario === "link-rollback") {
                    expect(log).toHaveBeenCalledWith(
                      expect.stringContaining("State dir migration rolled back"),
                    );
                    expect(fs.lstatSync(legacy).isSymbolicLink()).toBe(false);
                    expect(fs.existsSync(state.stateDir)).toBe(false);
                  } else {
                    expect(log).toHaveBeenCalledWith(
                      `State dir: ${legacy} → ${state.stateDir} (legacy path now symlinked)`,
                    );
                    expect(fs.realpathSync(legacy)).toBe(fs.realpathSync(state.stateDir));
                  }
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
                expect(maintenance!.databaseWrites).toEqual({
                  unchanged: scenario === "receipt-unchanged",
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
