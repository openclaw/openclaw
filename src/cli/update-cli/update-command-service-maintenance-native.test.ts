import "./update-command-service-maintenance.test-support.js";
import "./update-command-service-maintenance-native.test-support.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import * as launchdExec from "../../daemon/launchd-exec.js";
import { buildLaunchAgentPlist } from "../../daemon/launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "../../daemon/launchd-plist.test-support.js";
import * as launchdRuntime from "../../daemon/launchd-runtime.js";
import { resolveLaunchAgentPlistPath } from "../../daemon/launchd-service-files.js";
import { stopLaunchAgent } from "../../daemon/launchd-stop.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import { withGatewayServiceUpdateAuthority } from "../../daemon/service-update-authority.js";
import { readGatewayOwnerLease } from "../../infra/gateway-owner-lease.js";
import * as ports from "../../infra/ports-inspect.js";
import * as ancestry from "../../infra/restart-stale-pids.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun, getUpdateRunAsync } from "../../infra/update-run-ledger.js";
import * as phaseWrites from "../../infra/update-run-write.async.js";
import * as exec from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as pidAlive from "../../shared/pid-alive.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import {
  gatewayCommand,
  nativeResult,
  writeHandoffMeta,
} from "./update-command-service-fixtures.test-support.js";

const { mocks, withServiceHome } =
  await import("./update-command-service-maintenance.test-support.js");
const { runNativeMaintenanceUpdate } =
  await import("./update-command-service-maintenance-native.test-support.js");

function mutateHandoff(sql: string, value: string, root: string) {
  const db = new DatabaseSync(resolveManagedUpdateLeaseDatabasePath());
  try {
    db.prepare(sql).run(value, root);
  } finally {
    db.close();
  }
}

it
  .runIf(process.platform === "darwin" || process.platform === "linux")
  .each([
    "activation helper",
    "activation helper with retained service root",
    "held service phase acknowledgement",
    "revoked after service phase acknowledgement",
    "tuple-only caller",
    "unrecorded helper",
    "revoked at native stop",
    "revoked after inspection with disable",
    "revoked after disable",
    "revoked before port cleanup",
  ] as const)("enforces live handoff authority in the real LaunchAgent stop: %s", (scenario) =>
  withServiceHome(async (home) => {
    const root = await fs.realpath(process.cwd());
    const retainedService = scenario === "activation helper with retained service root";
    const callerRoot = retainedService ? path.join(home, "caller-install") : root;
    if (retainedService) {
      await fs.mkdir(callerRoot);
      await fs.writeFile(
        path.join(callerRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.6", bin: "openclaw.mjs" }),
      );
      await fs.writeFile(path.join(callerRoot, "openclaw.mjs"), "// Fixture package entrypoint.\n");
    }
    const runId = randomUUID();
    const heldServicePhase =
      scenario === "held service phase acknowledgement" ||
      scenario === "revoked after service phase acknowledgement";
    const productionCaller =
      retainedService ||
      heldServicePhase ||
      ["activation helper", "revoked at native stop"].includes(scenario);
    const label = "ai.openclaw.native-stop-test";
    // Bootout must kill a real process; refused authority must leave it serving.
    const child = spawn(
      process.execPath,
      ["-e", "process.stdout.write('ready\\n'); process.stdin.resume()"],
      { env: { HOME: home }, stdio: ["pipe", "pipe", "pipe"] },
    );
    const closed = once(child, "close");
    const output = new PassThrough();
    try {
      await once(child.stdout!, "data");
      const gatewayPid = child.pid!;
      const store = createManagedHandoffLeaseStore({
        databasePath: resolveManagedUpdateLeaseDatabasePath(),
        serviceManagerEnv: process.env,
      });
      const claim = store.acquire(callerRoot, "native-stop-handoff", { kind: "update" });
      if (claim.kind !== "acquired") {
        throw new Error("fixture could not acquire its handoff lease");
      }
      const revokeAt = (point: typeof scenario) => {
        if (scenario === point) {
          expect(store.release(claim.lease)).toBe(true);
        }
      };
      createUpdateRun({ runId, trigger: "cli" }, { env: process.env });
      const metaPath = await writeHandoffMeta(home, callerRoot, runId, claim.lease.owner);
      revokeAt("unrecorded helper");
      mockProcessPlatform("darwin");
      if (productionCaller) {
        // Admission still checks both live identities and the lease after handoff.
        const helperStart = pidAlive.getFileLockProcessStartTime(process.ppid);
        expect(helperStart).not.toBeNull();
        mutateHandoff(
          "UPDATE managed_update_handoffs SET payload_json=? WHERE install_root=?",
          JSON.stringify({
            version: 2,
            helper: { pid: process.ppid, startIdentity: String(helperStart) },
            executor: claim.lease.executor,
            action: { kind: "update" },
          }),
          callerRoot,
        );
      }
      vi.spyOn(exec, "runExec").mockImplementation(async (command, args, options) => {
        if (command !== "/usr/bin/plutil" || typeof options !== "object" || !options.input) {
          throw new Error(`Unexpected fixture subprocess: ${command}`);
        }
        return decodeLaunchAgentPlistFixture(options.input, args[1]);
      });
      const effectiveEnv = {
        HOME: home,
        OPENCLAW_LAUNCHD_LABEL: label,
        OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
        OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw", "openclaw.json"),
      };
      await fs.writeFile(effectiveEnv.OPENCLAW_CONFIG_PATH, "{}");
      const plist = resolveLaunchAgentPlistPath(effectiveEnv);
      await fs.mkdir(path.dirname(plist), { recursive: true });
      await fs.writeFile(
        plist,
        buildLaunchAgentPlist({
          label,
          programArguments: gatewayCommand(home, root).programArguments,
          stdoutPath: path.join(home, "stdout.log"),
          stderrPath: path.join(home, "stderr.log"),
          environment: effectiveEnv,
        }),
      );
      const startedAt = pidAlive.getFileLockProcessStartTime(gatewayPid);
      expect(startedAt).not.toBeNull();
      const db = openOpenClawStateDatabase({ env: effectiveEnv }).db;
      const now = Date.now();
      db.prepare(`INSERT INTO state_leases
      (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
      VALUES ('gateway-owner', 'global', 'native-caller-owner', ?, ?, ?, ?, ?)`).run(
        now + 300000,
        now,
        JSON.stringify({
          owner: { pid: gatewayPid, host: hostname(), startedAt },
          port: 43210,
          mode: "supervised",
          supervisor: { kind: "launchd", name: label },
        }),
        now,
        now,
      );
      expect(readGatewayOwnerLease({ env: effectiveEnv, current: true })).toMatchObject({
        pid: gatewayPid,
        startedAt,
        state: "live",
      });
      const intent = () => db.prepare("SELECT pid, reason FROM gateway_restart_intent").get();
      let atBootout: ReturnType<typeof intent>;
      const callerPids = new Set([process.pid, process.ppid, gatewayPid]);
      vi.spyOn(ancestry, "getSelfAndAncestorPidsSync").mockReturnValue(callerPids);
      vi.spyOn(ancestry, "inspectSelfAndAncestorPidsSync").mockReturnValue({
        pids: callerPids,
        complete: true,
      });
      const cleanup = vi.spyOn(ancestry, "cleanStaleGatewayProcessesSync").mockReturnValue([]);
      vi.spyOn(ports, "inspectPortUsage").mockResolvedValue({
        port: 43210,
        status: "free",
        listeners: [],
        hints: [],
      });
      vi.spyOn(launchdRuntime, "resolveLaunchAgentGatewayContext").mockImplementation(async () => {
        revokeAt("revoked before port cleanup");
        return {
          env: {},
          port: scenario === "revoked before port cleanup" ? 43210 : null,
          probeHosts: [],
        };
      });
      let loaded = true;
      const nativeCalls: string[][] = [];
      let inspections = 0;
      vi.spyOn(launchdExec, "execLaunchctl").mockImplementation(async (args) => {
        nativeCalls.push(args);
        if (args[0] === "print-disabled") {
          return nativeResult(`"${label}" => enabled`);
        }
        if (args[0] === "print" && args[1]?.startsWith("system/")) {
          return nativeResult("", 113, "Could not find service");
        }
        if (args[0] === "print") {
          inspections += 1;
          if (inspections === 2) {
            revokeAt("revoked after inspection with disable");
          }
          return loaded
            ? nativeResult(`${args[1]} = {\n\tstate = running\n\tpid = ${gatewayPid}\n}`)
            : nativeResult("", 113, "Could not find service");
        }
        if (args[0] === "disable") {
          revokeAt("revoked after disable");
          return nativeResult();
        }
        expect(args[0]).toBe("bootout");
        if (retainedService) {
          expect(store.read(callerRoot)).toMatchObject({
            kind: "current",
            lease: { owner: claim.lease.owner, executor: { pid: process.pid } },
          });
          expect(store.read(root)).toMatchObject({
            kind: "current",
            lease: { executor: { pid: process.pid } },
          });
        }
        atBootout = intent();
        await stopChildProcess(child, 5000);
        await closed;
        loaded = false;
        return nativeResult();
      });
      await withEnvAsync(
        {
          OPENCLAW_UPDATE_RUN_HANDOFF: "1",
          [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
          OPENCLAW_LAUNCHD_LABEL: label,
          OPENCLAW_SERVICE_MARKER: undefined,
          OPENCLAW_SERVICE_KIND: undefined,
          LAUNCH_JOB_LABEL: undefined,
          LAUNCH_JOB_NAME: undefined,
          XPC_SERVICE_NAME: undefined,
        },
        async () => {
          const { resolveGatewayService } =
            await vi.importActual<typeof import("../../daemon/service.js")>(
              "../../daemon/service.js",
            );
          const service = resolveGatewayService();
          const revokeExecutor = () =>
            mutateHandoff(
              "UPDATE managed_update_handoffs SET owner=? WHERE install_root=?",
              "revoked-native-stop-owner",
              root,
            );
          const receiptCommitted = createDeferredCore();
          const releaseReceipt = createDeferredCore();
          const stopEntered = createDeferredCore();
          let observingServiceWrite = false;
          let activatingReceipts = 0;
          const hostWrites: string[] = [];
          const observeSql = (sql: string) => {
            if (
              observingServiceWrite &&
              /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+["`]?update_runs\b/i.test(sql)
            ) {
              hostWrites.push(sql);
            }
          };
          const prepare = heldServicePhase
            ? vi.spyOn(DatabaseSync.prototype, "prepare")
            : undefined;
          const execute = heldServicePhase ? vi.spyOn(DatabaseSync.prototype, "exec") : undefined;
          if (prepare && execute) {
            DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql) {
              observeSql(sql);
              return prepare.call(this, sql);
            };
            DatabaseSync.prototype.exec = function (this: DatabaseSync, sql) {
              observeSql(sql);
              return execute.call(this, sql);
            };
          }
          const originalWrite = phaseWrites.recordUpdateRunPhaseAsync;
          const phaseWrite = heldServicePhase
            ? vi
                .spyOn(phaseWrites, "recordUpdateRunPhaseAsync")
                .mockImplementation(async (...args) => {
                  const record = await originalWrite(...args);
                  if (args[1] === "activating") {
                    activatingReceipts += 1;
                    if (activatingReceipts === 1) {
                      // Observe service preparation, not execution's earlier phase.
                      observingServiceWrite = true;
                    } else if (activatingReceipts === 2) {
                      receiptCommitted.resolve();
                      await releaseReceipt.promise;
                    }
                  }
                  return record;
                })
            : undefined;
          const nativeStop = service.stop;
          const stopCall = vi.spyOn(service, "stop").mockImplementation(async (args) => {
            observingServiceWrite = false;
            stopEntered.resolve();
            if (scenario === "revoked at native stop") {
              revokeExecutor();
            }
            await nativeStop(args);
          });
          mocks.service.mockReturnValue(service);
          const nativeArgs = {
            env: process.env,
            stdout: output,
            disable:
              scenario === "revoked after inspection with disable" ||
              scenario === "revoked after disable",
            updateHandoff: { root, runId },
          };
          const stop = () =>
            productionCaller
              ? runNativeMaintenanceUpdate(
                  callerRoot,
                  runId,
                  claim.lease.owner,
                  retainedService ? root : undefined,
                )
              : scenario === "tuple-only caller"
                ? service.stop(nativeArgs)
                : withGatewayServiceOperationLock(process.env, (assertCurrent) =>
                    withGatewayServiceUpdateAuthority(
                      assertCurrent,
                      () => stopLaunchAgent(nativeArgs),
                      { originalRoot: root },
                    ),
                  );
          const authorized =
            scenario === "activation helper" ||
            retainedService ||
            scenario === "held service phase acknowledgement";
          const pending = stop();
          try {
            if (heldServicePhase) {
              const reached = await Promise.race([
                receiptCommitted.promise.then(() => "service-receipt"),
                stopEntered.promise.then(() => "native-stop"),
                pending.then(() => "command-completed"),
              ]);
              expect([hostWrites, reached, activatingReceipts]).toEqual([[], "service-receipt", 2]);
              expect(stopCall).not.toHaveBeenCalled();
              expect([loaded, pidAlive.isPidAlive(gatewayPid)]).toEqual([true, true]);
              expect(await getUpdateRunAsync(runId, { env: effectiveEnv })).toMatchObject({
                runId,
                phase: "activating",
                status: "running",
              });
              observingServiceWrite = false;
              if (scenario === "revoked after service phase acknowledgement") {
                revokeExecutor();
              }
              releaseReceipt.resolve();
            }
            if (authorized) {
              await pending;
              if (retainedService) {
                expect(store.read(root)).toEqual({ kind: "absent" });
              }
            } else {
              await expect(pending).rejects.toThrow(
                productionCaller
                  ? /Update executor ownership is no longer current/
                  : `Refusing to stop LaunchAgent ${label} from inside the same launchd service`,
              );
            }
            if (scenario === "revoked after service phase acknowledgement") {
              expect(stopCall).not.toHaveBeenCalled();
            }
            const target = `${launchdRuntime.resolveLaunchAgentGuiDomain()}/${label}`;
            const bootedOut = authorized || scenario === "revoked before port cleanup";
            expect(
              nativeCalls.filter(
                ([command]) => command !== "print" && command !== "print-disabled",
              ),
            ).toEqual(
              bootedOut
                ? [["bootout", target]]
                : scenario === "revoked after disable"
                  ? [["disable", target]]
                  : [],
            );
            const expectedIntent = bootedOut
              ? { pid: gatewayPid, reason: "update.run" }
              : undefined;
            expect([loaded, pidAlive.isPidAlive(gatewayPid)]).toEqual([!bootedOut, !bootedOut]);
            expect([atBootout, intent()]).toEqual([expectedIntent, expectedIntent]);
            expect(cleanup).not.toHaveBeenCalled();
          } finally {
            releaseReceipt.resolve();
            await pending.catch(() => undefined);
            phaseWrite?.mockRestore();
            prepare?.mockRestore();
            execute?.mockRestore();
            stopCall.mockRestore();
          }
        },
      );
    } finally {
      await stopChildProcess(child, 5000);
      await closed;
      output.destroy();
      await closeStateDatabaseForTest();
    }
  }),
);
