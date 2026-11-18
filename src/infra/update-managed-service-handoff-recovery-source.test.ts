import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { HANDOFF_OWNED_COMMAND_SCRIPT } from "./update-managed-service-handoff-control.js";
import { MANAGED_HANDOFF_LEASE_SOURCE } from "./update-managed-service-handoff-lease-source.js";
import { MANAGED_HANDOFF_RECOVERY_SOURCE } from "./update-managed-service-handoff-recovery-source.js";
import { MANAGED_HANDOFF_RESULT_SOURCE } from "./update-managed-service-handoff-result-source.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const exec = promisify(execFile);
const admissionModule = new URL("./sqlite-database-admission-context.ts", import.meta.url).href;
const tsconfig = fileURLToPath(new URL("../../tsconfig.json", import.meta.url));
const tsx = import.meta.resolve("tsx/esm/api");

it.each(["observation", "restoration", "unsafe"] as const)(
  "handles %s when the helper retains a predecessor SQLite registry",
  async (mode) => {
    const root = fs.realpathSync(dirs.make("handoff-probe-"));
    const predecessor = path.join(root, "predecessor.mjs");
    const candidate = path.join(root, "candidate.mjs");
    const helper = path.join(root, "helper.mjs");
    const logPath = path.join(root, "helper.log");

    // Model the predecessor's published admissions and registry interface. The real
    // installed admission code consumes this snapshot and calls captureExchange
    // on the predecessor registry if loaded in the same process.
    fs.writeFileSync(
      predecessor,
      `import { setEnvironmentData } from "node:worker_threads";
      globalThis[Symbol.for("openclaw.sqliteDatabaseAdmissions")] = { registry: { install() {} } };
      setEnvironmentData("openclaw.sqliteDatabaseAdmissions.v1", []);`,
    );
    fs.writeFileSync(
      candidate,
      `const { register } = await import(${JSON.stringify(tsx)});
      register({ tsconfig: ${JSON.stringify(tsconfig)} });
      const { withSqliteDatabaseAdmissionExchange, exchangeSqliteDatabaseAdmission } = await import(${JSON.stringify(admissionModule)});
      export async function waitForGatewayUpdateRecovery(version, buildId, timeoutMs) {
        withSqliteDatabaseAdmissionExchange((admissions) => admissions, () =>
          exchangeSqliteDatabaseAdmission(${JSON.stringify(path.join(root, "fixture.sqlite"))}));
        if (version !== "2.0.0" || buildId !== "candidate-build" || timeoutMs !== 3000)
          throw new Error("unexpected probe inputs");
        return { healthy: true, runtime: { status: "running", pid: process.pid },
          gatewayVersion: "2.0.0", gatewayBuildId: "candidate-build" };
      }`,
    );
    fs.writeFileSync(
      helper,
      `import "./predecessor.mjs";
      import fs from "node:fs";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      import { spawn } from "node:child_process";

      const params = {
        action: "update", cwd: ${JSON.stringify(root)}, updateLeaseKey: ${JSON.stringify(root)},
        logPath: ${JSON.stringify(logPath)}, recoveryModulePath: ${JSON.stringify(candidate)},
        recoveryTimeoutMs: 3000, runtimeArgs: [], nodeExecArgv: [], parentPid: 1,
        serviceRecovery: { kind: "systemd", unit: "fixture.service" },
        recovery: ${JSON.stringify(
          mode === "unsafe"
            ? {
                serviceRestartSafe: false,
                dataAtRisk: "state-migrated-no-rollback",
                version: "2.0.0",
              }
            : { serviceRestartSafe: true, version: "2.0.0", buildId: "candidate-build" },
        )},
      };
      const logs = [], starts = [], recorded = [];
      const appendLog = (line) => logs.push(line);
      const terminationRequested = false;
      const restorationArmed = ${mode !== "observation"};
      let activeCommand;
      let managedUpdateLease = { payload: "helper", action: { kind: "update" }, executor: { pid: process.pid } };
      const leaseStore = {
        owns: (lease) => lease === managedUpdateLease,
        bind: (lease, pid) => ({ ...lease, payload: String(pid), executor: { pid } }),
      };
      const assertTriageRequester = () => {};
      const killOwnedCommand = (child) => child.kill("SIGKILL");

      // Native service and ledger I/O are fixtures. The helper runs the shipped
      // lease gate, process runner and recovery decisions with real child imports.
      const pendingServiceStop = Promise.resolve({ code: 0 });
      const isParkedSystemdGeneration = () => true;
      const isPidAlive = () => true;
      const parkedServiceGeneration = "old-start";
      async function inspectSystemdService() {
        const active = starts.length > 0;
        return { Id: "fixture.service", LoadState: "loaded", ActiveState: active ? "active" : "inactive",
          MainPID: active ? "4242" : "0", ExecMainStartTimestampMonotonic: active ? "2" : "1" };
      }
      async function runServiceCommand(...args) { starts.push(args); return { code: 0 }; }

      ${MANAGED_HANDOFF_LEASE_SOURCE}
      ${HANDOFF_OWNED_COMMAND_SCRIPT}
      ${MANAGED_HANDOFF_RESULT_SOURCE}
      ${MANAGED_HANDOFF_RECOVERY_SOURCE}
      recordManagedUpdateOutcome = async (_reason, restored) => { recorded.push(restored); return true; };
      let verification;
      runLedger = { recordUpdateRunVerification(_runId, facts) { verification = facts; } };
      triageFailure = { reason: "activation-refused" };
      let restored;
      if (${JSON.stringify(mode)} === "observation") {
        await observeUnrecordedRecovery();
        verification = recoveryObservation.verification;
      } else {
        restored = await restoreGatewayService("activation-refused");
      }
      process.stdout.write(JSON.stringify({ restored, verification, triageFailure, logs, starts, recorded,
        helperPid: process.pid, executorPid: managedUpdateLease.executor.pid }));`,
    );

    const { stdout } = await exec(resolveTestNodeExecPath(), [helper], {
      cwd: root,
      timeout: 10_000,
    });
    const result = JSON.parse(stdout);
    if (mode === "unsafe") {
      expect(result).toMatchObject({ restored: false, starts: [], recorded: [false] });
      return;
    }
    const diagnostic = [
      ...result.logs,
      fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "",
    ].join("\n");
    expect(result.verification, diagnostic).toMatchObject({
      serviceRunning: true,
      runningVersion: "2.0.0",
      runningBuildId: "candidate-build",
      versionMatch: true,
      settled: true,
    });
    expect(result.verification.pid).toEqual(expect.any(Number));
    expect(result.verification.pid).not.toBe(result.helperPid);
    expect(result.executorPid).toBe(result.helperPid);
    expect(fs.readdirSync(root)).not.toContain("recovery-probe.json");
    if (mode === "observation") {
      expect(result).toMatchObject({ triageFailure: { restored: true }, starts: [] });
    } else {
      expect(result).toMatchObject({
        restored: true,
        recorded: [true],
        starts: [["systemctl", ["--user", "start", "fixture.service"]]],
      });
    }
  },
  15_000,
);
