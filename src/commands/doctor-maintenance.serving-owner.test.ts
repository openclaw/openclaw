import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { maybeStopManagedServiceBeforeMutableUpdate } from "../cli/update-cli/update-command-service-maintenance.js";
import { mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import { readGatewayOwnerLease } from "../infra/gateway-owner-lease.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { createDanglingSkillWorkshopReviewIndex } from "../state/openclaw-state-db-corruption.test-support.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import * as stateReadonly from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { acquireOpenClawStateLeaseInTransaction } from "../state/openclaw-state-lease-store.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { useDoctorMaintenanceRuntimeDirectory } from "./doctor-maintenance.test-support.js";

const boundary = vi.hoisted(() => ({
  stop: vi.fn<typeof maybeStopManagedServiceBeforeMutableUpdate>(),
}));

// The service is synthetic; lease storage, physical contention, and Doctor's reader stay real.
vi.mock("../cli/update-cli/update-command-service-maintenance.js", async (original) => ({
  ...(await original<typeof import("../cli/update-cli/update-command-service-maintenance.js")>()),
  maybeStopManagedServiceBeforeMutableUpdate: boundary.stop,
}));
vi.mock("./doctor-service-repair-policy.js", async (original) => ({
  ...(await original<typeof import("./doctor-service-repair-policy.js")>()),
  shouldManageGatewayService: async () => true,
}));
vi.mock("./doctor-maintenance-stale-service.js", async (original) => ({
  ...(await original<typeof import("./doctor-maintenance-stale-service.js")>()),
  inspectStaleDoctorGateway: async () => undefined,
}));
vi.mock("./doctor-update-refusal.js", async (original) => ({
  ...(await original<typeof import("./doctor-update-refusal.js")>()),
  resolveUpdateDoctorGitRecovery: async () => undefined,
}));

const directories = useAutoCleanupTempDirTracker(afterEach);
useDoctorMaintenanceRuntimeDirectory(() => directories.make("doctor-serving-owner-runtime-"));
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  "current",
  "old-schema",
  "legacy-index",
  "missing",
  "foreign-host",
  "revoked",
  "cancelled",
  "selected-source",
  "process-exited",
] as const)("observes the serving Gateway off thread before a service stop: %s", async (kind) => {
  const servingProcess =
    kind === "process-exited"
      ? spawn(resolveTestNodeExecPath(), ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
      : undefined;
  try {
    if (servingProcess) {
      await once(servingProcess, "spawn");
    }
    const servingPid = servingProcess?.pid ?? process.pid;
    await withOpenClawTestState(
      { layout: "home", scenario: "minimal", label: "doctor-serving-owner" },
      async (state) => {
        mockSystemAccountHome();
        vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
        vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
        vi.stubEnv("OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION", undefined);
        const databasePath = state.statePath("state", "openclaw.sqlite");
        if (kind !== "missing") {
          const { db } = openOpenClawStateDatabase({ env: state.env, path: databasePath });
          const startedAt = getFileLockProcessStartTime(servingPid);
          expect(startedAt).not.toBeNull();
          runSqliteImmediateTransactionSync(db, () => {
            acquireOpenClawStateLeaseInTransaction(
              db,
              { scope: "gateway-owner", key: "global", owner: "serving-gateway" },
              600_000,
              JSON.stringify({
                owner: {
                  pid: servingPid,
                  host: kind === "foreign-host" ? "other-host.invalid" : hostname(),
                  startedAt,
                },
                port: 19483,
                mode: "supervised",
                supervisor: { kind: "external", name: "synthetic-manager" },
              }),
            );
          });
          if (kind === "old-schema") {
            db.exec(`PRAGMA user_version = 15;
              UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';
              DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion';`);
          }
          await closeOpenClawStateDatabaseAsync();
          if (kind === "legacy-index") {
            createDanglingSkillWorkshopReviewIndex(databasePath);
          }
        }
        const before = fs.existsSync(databasePath) ? fs.readFileSync(databasePath) : undefined;
        const predecessor = acquireGatewayStateOwner({
          databasePath,
          payload: {
            pid: process.pid,
            role: "gateway",
            createdAt: new Date().toISOString(),
            configPath: state.configPath,
            stateDir: state.stateDir,
          },
        });
        let restoreObservation: (() => void) | undefined;
        try {
          const sourceFiles = () =>
            fs.existsSync(path.dirname(databasePath))
              ? fs.readdirSync(path.dirname(databasePath)).toSorted()
              : undefined;
          const beforeFiles = sourceFiles();
          const sql = observeHostDataSql();
          restoreObservation = sql.restore;
          const leaseQueries = () =>
            sql.queries.filter((query) => /from\s+"?state_leases"?/iu.test(query));
          let atStop: string[] | undefined;
          const reachedStop = new Error("synthetic service stop boundary reached");
          boundary.stop.mockReset().mockImplementation(async (params) => {
            params.assertCurrent?.();
            if (params.phase !== "inspect") {
              atStop = leaseQueries();
              throw reachedStop;
            }
            return {
              stopped: false,
              inspected: true,
              runtimeInspected: true,
              running: true,
              serviceEnv: state.env,
              servicePid: servingPid,
              serviceUpdateVerdict: {
                kind: "owned",
                root: state.root,
                fingerprint: "synthetic-serving-service",
                refreshDefinition: false,
              },
            };
          });
          if (kind !== "missing") {
            expect(
              readGatewayOwnerLease({
                env: state.env,
                current: true,
                openStateSchemaReadAdmission: openDoctorStateSchemaReadAdmission,
              })?.owner,
            ).toBe("serving-gateway");
            expect(leaseQueries().length).toBeGreaterThan(0);
          }
          sql.queries.length = 0;
          const held =
            kind === "revoked" ||
            kind === "cancelled" ||
            kind === "selected-source" ||
            kind === "process-exited";
          const entered = createDeferredCore();
          const resume = createDeferredCore();
          const controller = new AbortController();
          const refused = new Error(`Doctor observation ${kind}`);
          let authorized = true;
          if (held) {
            const execute = stateReadonly.executeExistingOpenClawStateRead;
            vi.spyOn(stateReadonly, "executeExistingOpenClawStateRead").mockImplementation(
              async (...args) => {
                if (args[1].type !== "doctor.gatewayOwnerLease.read") {
                  return execute(...args);
                }
                if (kind === "selected-source") {
                  entered.resolve();
                  await resume.promise;
                  return execute(...args);
                }
                const reply = await execute(...args);
                if (kind === "process-exited") {
                  expect(reply).toMatchObject({
                    ok: true,
                    lease: { pid: servingPid, state: "live" },
                  });
                }
                entered.resolve();
                await resume.promise;
                return reply;
              },
            );
          }
          const operation = withCommandProcessScope(
            () =>
              beginDoctorMaintenance({
                options: { repair: true, nonInteractive: true },
                root: state.root,
                runtime: { log() {}, error() {}, exit() {} },
                assertCurrent: () => {
                  if (!authorized) {
                    throw refused;
                  }
                },
              }),
            controller.signal,
          );
          const settled = operation.then(
            () => undefined,
            (error: unknown) => error,
          );
          const live = ![
            "missing",
            "foreign-host",
            "revoked",
            "cancelled",
            "process-exited",
          ].includes(kind);
          try {
            if (held) {
              await Promise.race([
                entered.promise,
                settled.then(() => {
                  throw new Error("Doctor settled before the held read");
                }),
              ]);
              if (kind === "revoked") {
                authorized = false;
              } else if (kind === "cancelled") {
                controller.abort(refused);
              } else if (servingProcess) {
                await stopChildProcess(servingProcess, 5000);
              } else {
                vi.stubEnv("OPENCLAW_STATE_DIR", directories.make("doctor-other-installation-"));
              }
              resume.resolve();
            }
            await expect(operation).rejects.toThrow(
              live
                ? reachedStop.message
                : kind === "revoked" || kind === "cancelled"
                  ? refused.message
                  : kind === "missing"
                    ? "Gateway lock owner identity could not be verified"
                    : "OpenClaw state database is busy",
            );
          } finally {
            resume.resolve();
            await settled;
          }
          expect(boundary.stop).toHaveBeenCalledTimes(live ? 2 : 1);
          if (live) {
            expect(atStop).toEqual([]);
          }
          expect(leaseQueries()).toEqual([]);
          expect(fs.existsSync(databasePath)).toBe(before !== undefined);
          if (before) {
            expect(fs.readFileSync(databasePath)).toEqual(before);
          }
          expect(sourceFiles()).toEqual(beforeFiles);
        } finally {
          restoreObservation?.();
          predecessor?.release();
        }
      },
    );
  } finally {
    if (servingProcess) {
      await stopChildProcess(servingProcess, 5000);
    }
  }
});
