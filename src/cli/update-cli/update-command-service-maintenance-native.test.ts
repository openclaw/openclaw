import "./update-command-service-maintenance.test-support.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
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
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import { readGatewayOwnerLease } from "../../infra/gateway-owner-lease.js";
import * as ancestry from "../../infra/restart-stale-pids.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import * as bootReader from "../../infra/update-managed-service-handoff-boot.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import * as exec from "../../process/exec.js";
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

const { withServiceHome } = await import("./update-command-service-maintenance.test-support.js");

type StopScenario = {
  tuple?: true;
  revoke?: "unrecorded" | "inspection" | "disable" | "cleanup";
};
it
  .runIf(process.platform === "darwin" || process.platform === "linux")
  .each<[string, StopScenario]>([
    ["tuple-only caller", { tuple: true }],
    ["unrecorded helper", { revoke: "unrecorded" }],
    ["revoked after inspection with disable", { revoke: "inspection" }],
    ["revoked after disable", { revoke: "disable" }],
    ["revoked before port cleanup", { revoke: "cleanup" }],
  ])(
  "enforces live handoff authority in the real LaunchAgent stop: %s",
  (_name, { tuple, revoke }) =>
    withServiceHome(async (home) => {
      const root = await fs.realpath(process.cwd());
      const runId = randomUUID();
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
        const claim = store.acquire(root, "native-stop-handoff", { kind: "update" });
        if (claim.kind !== "acquired") {
          throw new Error("fixture could not acquire its handoff lease");
        }
        const revokeAt = (point: StopScenario["revoke"]) => {
          if (revoke === point) {
            expect(store.release(claim.lease)).toBe(true);
          }
        };
        createUpdateRun({ runId, trigger: "cli" }, { env: process.env });
        const metaPath = await writeHandoffMeta(home, root, runId, claim.lease.owner);
        revokeAt("unrecorded");
        vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader").mockReturnValue(() => ({
          platform: "darwin",
          identity: "01234567-89ab-cdef-0123-456789abcdef",
        }));
        mockProcessPlatform("darwin");
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
            owner: {
              pid: gatewayPid,
              host: hostname(),
              startedAt,
              processNamespace: readGatewayLockProcessNamespace(),
            },
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
        const cleanup = vi.spyOn(ancestry, "cleanStaleGatewayProcesses").mockResolvedValue([]);
        vi.spyOn(launchdRuntime, "resolveLaunchAgentGatewayContext").mockImplementation(
          async () => {
            revokeAt("cleanup");
            return {
              env: {},
              port: revoke === "cleanup" ? 43210 : null,
              probeHosts: [],
            };
          },
        );
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
              revokeAt("inspection");
            }
            return loaded
              ? nativeResult(`${args[1]} = {\n\tstate = running\n\tpid = ${gatewayPid}\n}`)
              : nativeResult("", 113, "Could not find service");
          }
          if (args[0] === "disable") {
            revokeAt("disable");
            return nativeResult();
          }
          expect(args[0]).toBe("bootout");
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
            const nativeArgs = {
              env: process.env,
              stdout: output,
              disable: revoke === "inspection" || revoke === "disable",
              updateHandoff: { root, runId },
            };
            const pending = tuple
              ? service.stop(nativeArgs)
              : withGatewayServiceOperationLock(process.env, (assertCurrent) =>
                  withGatewayServiceUpdateAuthority(
                    assertCurrent,
                    () => stopLaunchAgent(nativeArgs),
                    { originalRoot: root },
                  ),
                );
            await expect(pending).rejects.toThrow(
              `Refusing to stop LaunchAgent ${label} from inside the same launchd service`,
            );
            const target = `${launchdRuntime.resolveLaunchAgentGuiDomain()}/${label}`;
            const bootedOut = revoke === "cleanup";
            expect(
              nativeCalls.filter(
                ([command]) => command !== "print" && command !== "print-disabled",
              ),
            ).toEqual(
              bootedOut ? [["bootout", target]] : revoke === "disable" ? [["disable", target]] : [],
            );
            const expectedIntent = bootedOut
              ? { pid: gatewayPid, reason: "update.run" }
              : undefined;
            expect([loaded, pidAlive.isPidAlive(gatewayPid)]).toEqual([!bootedOut, !bootedOut]);
            expect([atBootout, intent()]).toEqual([expectedIntent, expectedIntent]);
            expect(cleanup).not.toHaveBeenCalled();
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
