import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/config.js";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import { isDefaultInstallIdentity } from "../../config/paths.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { FILE_LOCK_TIMEOUT_ERROR_CODE, withFileLock } from "../../infra/file-lock.js";
import { runPackagePostInstallVerification } from "../../infra/package-update-verification-step.js";
import { materializeUpdateCandidateStateWorker } from "../../infra/update-candidate-state.test-support.js";
import { NativePackageRollbackError } from "../../infra/update-native-package-stage.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import * as processRunner from "../../process/exec.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import type { UpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import { resultFixture } from "./update-command-fixtures.test-support.js";
import * as packageIdentity from "./update-command-package-identity.js";
import { inspectManagedGatewayServiceBeforeUpdate } from "./update-command-service-plan.js";
import { createWindowsTaskAutoStartRecovery } from "./update-command-windows-task.js";

const mocks = vi.hoisted(() => ({
  stop: vi.fn<
    typeof import("./update-command-service.js").maybeStopManagedServiceBeforeMutableUpdate
  >(),
  restart: vi.fn<typeof import("./update-command-service.js").maybeRestartService>(),
  serviceState: vi.fn<typeof import("../../daemon/service.js").readGatewayServiceState>(),
  execSchtasks: vi.fn<typeof import("../../daemon/schtasks-exec.js").execSchtasks>(),
}));
// mock-isolation: Rollback owns a synthetic task; native enable/disable must not reach the host.
vi.mock("../../daemon/schtasks-exec.js", () => ({
  execSchtasks: mocks.execSchtasks,
  execScheduledTaskEnabledChange: (taskName: string, enabled: boolean) =>
    mocks.execSchtasks(["/Change", "/TN", taskName, enabled ? "/ENABLE" : "/DISABLE"]),
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  readGatewayServiceState: mocks.serviceState,
}));
vi.mock("./update-command-service-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-maintenance.js")>()),
  createWindowsTaskAutoStartGuard: () => async () => {},
}));
vi.mock("./update-command-service.js", () => ({
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stop,
  maybeRestartService: mocks.restart,
  resolveUpdatedGatewayRestartPort: async () => 19101,
}));
import * as updateShared from "./shared.js";
import { inspectActivatedUpdateState } from "./update-command-migrated.js";
import * as packageModule from "./update-command-package.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import {
  expectActiveRollbackIdentity,
  readRollbackFixtureState,
  readRollbackFixtureSchemaVersions,
  registerRollbackReportTests,
  writeDoctorRollbackConfig,
  writeDoctorRollbackReceipt,
} from "./update-command-rollback.test-support.js";
import { completeUpdateCommandRun } from "./update-command-run.js";
import { resolveUpdateResultNextAction } from "./update-recovery-guidance.js";

const dirs = createTempDirTracker();
let candidateRoot: string;
let previousRoot: string;
let serviceStateDir: string;
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  dirs.cleanup();
});
function setVersion(file: string, version: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  using db = new DatabaseSync(file);
  db.exec(`PRAGMA user_version = ${version}`);
}

function failedCandidate(overrides: Partial<UpdateRunResult> = {}): UpdateRunResult {
  return resultFixture(candidateRoot, {
    status: "error",
    reason: "readyz-unhealthy",
    before: { version: "2026.9.1" },
    after: { version: "2026.9.3" },
    durationMs: 1,
    ...overrides,
  });
}

function restoredStep(name = "rollback") {
  return {
    name,
    activePackageRoot: previousRoot,
    command: "restore",
    cwd: previousRoot,
    exitCode: 0,
    durationMs: 1,
  };
}

function stoppedService(
  overrides: Partial<import("./update-command-service.js").PreManagedServiceStop> = {},
) {
  return {
    stopped: true,
    inspected: true,
    runtimeInspected: true,
    running: true,
    serviceEnv: { OPENCLAW_STATE_DIR: serviceStateDir },
    ...overrides,
  };
}

function schemaCase(
  change: string,
  restored: boolean,
  previousVerified = true,
  service = "stopped",
) {
  return { change, restored, previousVerified, service };
}

type RollbackInput = Parameters<typeof rollbackFailedUpdate>[0];
function runRollback(input: Pick<RollbackInput, "configSnapshot"> & Partial<RollbackInput>) {
  return rollbackFailedUpdate({
    definitionRecovery: {},
    previousRoot,
    result: failedCandidate(),
    opts: { json: true },
    timeoutMs: 1_000,
    ...input,
  });
}

describe("verified package rollback", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const serviceHome = fs.realpathSync(dirs.make("rollback-service-home-"));
    serviceStateDir = path.join(serviceHome, ".openclaw");
    fs.mkdirSync(serviceStateDir);
    vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: serviceHome });
    vi.stubEnv("HOME", serviceHome);
    vi.stubEnv("USERPROFILE", serviceHome);
    vi.stubEnv("OPENCLAW_HOME", undefined);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
    vi.stubEnv("OPENCLAW_PROFILE", undefined);
    expect(
      isDefaultInstallIdentity({ HOME: serviceHome, OPENCLAW_STATE_DIR: serviceStateDir }),
    ).toBe(true);
    previousRoot = fs.realpathSync(dirs.make("rollback-previous-runtime-"));
    candidateRoot = fs.realpathSync(dirs.make("rollback-candidate-runtime-"));
    for (const [root, version] of [
      [previousRoot, "2026.9.1"],
      [candidateRoot, "2026.9.3"],
    ] as const) {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", type: "module", version }),
      );
      fs.mkdirSync(path.join(root, "dist"));
      fs.writeFileSync(path.join(root, "dist", "index.js"), "export {};\n");
    }
    await materializeUpdateCandidateStateWorker(candidateRoot);
    mocks.serviceState.mockImplementation(async (_service, options) => ({
      installed: true,
      loadState: { status: "loaded" },
      running: false,
      runtime: { status: "stopped", systemd: { managerUid: 2001 } },
      env: options?.env ?? {},
      command: {
        programArguments: [
          process.execPath,
          path.join(previousRoot, "dist", "index.js"),
          "gateway",
        ],
      },
    }));
    mocks.stop.mockImplementation(async ({ expectedService, updateRun }) => {
      const env = expectedService?.serviceEnv ?? updateRun?.env ?? {};
      const state = await readGatewayServiceState(resolveGatewayService(), { env });
      return stoppedService({
        stoppedAtMs: 100,
        running: state.running,
        serviceEnv: env,
        serviceManagerUid: 2001,
        serviceUpdateVerdict: await inspectManagedGatewayServiceBeforeUpdate({
          state,
          root: previousRoot,
        }),
      });
    });
    mocks.restart.mockImplementation(async ({ onVerified }) => {
      onVerified?.(125);
      return "ok";
    });
  });
  registerRollbackReportTests(() => ({ candidateRoot, previousRoot, stateDir: serviceStateDir }));
  it.each([false, true])(
    "records refused project rollback without an additional stop (during stop=%s)",
    async (duringStop) => {
      const env = { OPENCLAW_STATE_DIR: serviceStateDir };
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      const { configSnapshot, schemaVersions } = await readRollbackFixtureState(
        serviceStateDir,
        env,
      );
      const rollback = vi.fn(async () => ({
        name: "global install rollback",
        activePackageRoot: candidateRoot,
        command: "restore",
        cwd: candidateRoot,
        durationMs: 1,
        exitCode: 1,
        reason: "rollback-project-changed" as const,
        stderrTail: detail,
      }));
      const detail = "Global project changed since staging: sibling";
      const outcome = await runRollback({
        result: failedCandidate({ mode: "pnpm", before: undefined, after: undefined }),
        schemaVersions,
        configSnapshot,
        opts: { json: true, run },
        preManagedServiceStop: stoppedService(),
        packageTransaction: {
          backupRoot: "/backup",
          assertRollbackSafe: async () => {
            if (!duringStop) {
              throw new NativePackageRollbackError(detail);
            }
          },
          rollback,
          complete: vi.fn(),
        },
      });
      expect(outcome.result).toMatchObject({
        status: "error",
        reason: "rollback-project-changed",
        root: candidateRoot,
        rollbackOutcome: { status: duringStop ? "failed" : "not-attempted" },
      });
      expect(rollback).toHaveBeenCalledTimes(duringStop ? 1 : 0);
      expect(mocks.stop).toHaveBeenCalledTimes(duringStop ? 1 : 0);
      expect(mocks.restart).not.toHaveBeenCalled();
      completeUpdateCommandRun(outcome.result, run);
      const row = getUpdateRun(run.runId, { env })!;
      expect(row).toMatchObject({
        status: "failed",
        reason: "rollback-project-changed",
        verification: { rollbackOutcome: outcome.result.rollbackOutcome },
        steps: expect.arrayContaining([
          expect.objectContaining({ step: "package rollback", status: "failed", detail }),
        ]),
      });
      const nextAction = resolveUpdateResultNextAction({
        result: outcome.result,
        env,
      });
      expect(renderUpdateRunReport(row, { nextAction }).markdown).toContain(
        "The new installation was left unchanged.",
      );
    },
  );
  it("retains Windows suspension through unhealthy rollback after activation", async () => {
    const stateDir = serviceStateDir;
    const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_WINDOWS_TASK_NAME: "rollback-fixture" };
    const { configSnapshot, schemaVersions } = await readRollbackFixtureState(stateDir, env);
    let enabled = true;
    const actions: string[] = [];
    mocks.execSchtasks.mockImplementation(async (args) => {
      if (args[0] === "/Query") {
        return {
          code: 0,
          stdout: `<Task><Settings><Enabled>${enabled}</Enabled></Settings></Task>`,
          stderr: "",
        };
      }
      const action = args[0] === "/Run" ? "/Run" : args.at(-1)!;
      actions.push(action);
      if (action === "/Run") {
        return { code: enabled ? 0 : 1, stdout: "", stderr: enabled ? "" : "task disabled" };
      }
      enabled = action === "/ENABLE";
      return { code: 0, stdout: "", stderr: "" };
    });
    const original = createWindowsTaskAutoStartRecovery({ serviceEnv: env });
    await original.suspended;
    original.beginMutation();
    await original.restore(true);
    let fresh: ReturnType<typeof createWindowsTaskAutoStartRecovery> | undefined;
    const verdict = await inspectManagedGatewayServiceBeforeUpdate({
      state: await readGatewayServiceState(resolveGatewayService(), { env }),
      root: previousRoot,
    });
    if (verdict.kind !== "owned") {
      throw new Error("Previous service fixture must resolve to its real package.");
    }
    const service = stoppedService({
      running: false,
      serviceEnv: env,
      serviceManagerUid: 2001,
      serviceUpdateVerdict: {
        ...verdict,
        refreshDefinition: false,
      },
    });
    mocks.stop.mockImplementationOnce(async () => {
      fresh = createWindowsTaskAutoStartRecovery({ serviceEnv: env });
      const suspended = await fresh.suspended;
      if (!suspended) {
        await fresh.complete();
      }
      return { ...service, windowsTaskAutoStartRecovery: suspended ? fresh : undefined };
    });
    mocks.restart.mockImplementationOnce(async ({ refreshServiceEnv }) => {
      expect(refreshServiceEnv).toBe(false);
      const running = await mocks.execSchtasks(["/Run", "/TN", "rollback-fixture"]);
      if (running.code !== 0) {
        throw new Error(running.stderr);
      }
      return "restart-health-failed";
    });
    try {
      const outcome = await runRollback({
        result: failedCandidate({ reason: "doctor-failed" }),
        schemaVersions,
        previousVerified: true,
        packageTransaction: {
          backupRoot: "/backup",
          complete: vi.fn(async () => {}),
          rollback: async () => restoredStep("package rollback"),
        },
        configSnapshot,
        preManagedServiceStop: { ...service, windowsTaskAutoStartRecovery: original },
      });
      expect(enabled).toBe(true);
      expect(outcome.rolledBack).toBe(false);
      expect(outcome.result.rollbackOutcome).toEqual({
        status: "succeeded",
        reason: "Previous package and configuration restored",
      });
      expect(outcome.result.recovery).toMatchObject({
        packageRollbackVerified: true,
        version: "2026.9.1",
        service: "failed",
      });
      const retained = outcome.stoppedForRollback?.windowsTaskAutoStartRecovery;
      expect(retained).toBe(fresh);
      await retained?.complete(false);
      expect(enabled).toBe(false);
      expect(actions.slice(-2)).toEqual(["/Run", "/DISABLE"]);
    } finally {
      await fresh?.complete(false);
      await original.complete(false);
    }
  });
  it.for([
    schemaCase("none", true),
    ...(process.platform === "win32" ? [] : [schemaCase("readonly-config", true)]),
    schemaCase("doctor", true),
    schemaCase("doctor-settled-exception", true),
    schemaCase("doctor-unchanged", true),
    schemaCase("doctor-compensated", true),
    schemaCase("doctor-missing-input", false),
    schemaCase("doctor-include", true),
    schemaCase("doctor-include-owned", true),
    schemaCase("doctor-include-owned-alias", true),
    schemaCase("doctor-include-owned-alias-edit", false),
    schemaCase("doctor-include-owned-edit", false),
    schemaCase("doctor-include-edit", false),
    schemaCase("doctor-input-edit", false),
    schemaCase("doctor-capture-edit", false),
    schemaCase("doctor-operator-edit", false),
    schemaCase("doctor-locked-edit", false),
    schemaCase("doctor-stop-edit", false),
    schemaCase("doctor-restore-edit", false),
    schemaCase("new-agent", true),
    schemaCase("new-agent-foreign", false),
    schemaCase("new-agent-previous-incompatible", false),
    schemaCase("new-agent-previous-unknown", false),
    schemaCase("identity-read-failed", true),
    schemaCase("shared", false),
    schemaCase("new-shared-deferred", false),
    schemaCase("agent", false),
    schemaCase("during-stop", false),
    schemaCase("unknown-runtime", false),
    schemaCase("none", false, false),
    schemaCase("none", false, true, "absent"),
    schemaCase("none", false, true, "no-restart"),
  ])(
    "$change schema change; previous verified=$previousVerified; service=$service",
    async ({ change, previousVerified, restored, service }, context) => {
      const includeAlias = change.startsWith("doctor-include-owned-alias");
      if (includeAlias && process.platform === "win32") {
        context.skip();
      }
      const stateDir = serviceStateDir;
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const { configPath, includePath, includeTarget, authored, originalRaw } =
        writeDoctorRollbackConfig(stateDir, change);
      const configSnapshot = await createConfigIO({
        env: process.env,
        pluginValidation: "skip",
      }).readConfigFileSnapshot();
      const config = configSnapshot.sourceConfigBeforeMigrations ?? configSnapshot.sourceConfig;
      let activationConfig: UpdateConfigSnapshot | undefined;
      const shared = path.join(stateDir, "state/openclaw.sqlite");
      const agent = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
      if (change !== "new-shared-deferred") {
        setVersion(shared, 7);
      }
      if (!change.startsWith("new-agent")) {
        setVersion(agent, 3);
      }
      const schemaVersions = await readRollbackFixtureSchemaVersions({ stateDir, config: {} });
      if (change === "new-shared-deferred") {
        expect(schemaVersions.find((entry) => entry.path === shared)?.userVersion).toBeNull();
        setVersion(shared, 7);
        using database = new DatabaseSync(shared);
        database.exec(`
            CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER);
            INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '8', 0);
          `);
      }
      if (change.startsWith("new-agent")) {
        setVersion(agent, change === "new-agent-foreign" ? 4 : 3);
      }
      if (change === "shared") {
        setVersion(shared, 8);
      }
      if (change === "agent") {
        setVersion(agent, 4);
      }
      if (change === "during-stop") {
        mocks.stop.mockImplementationOnce(async () => {
          setVersion(agent, 4);
          return { stopped: true, inspected: true, runtimeInspected: true, running: false };
        });
      }
      const result = failedCandidate({
        reason: change === "doctor-compensated" ? "doctor-failed" : "version-mismatch",
        root: change === "unknown-runtime" ? undefined : candidateRoot,
        durationMs: 10,
      });
      const operatorEdit = () =>
        fs.appendFileSync(configPath, "\n// Operator edit after activation.\n");
      if (change.startsWith("doctor")) {
        fs.writeFileSync(path.join(candidateRoot, "dist/entry.js"), "export {};\n");
        const writeDoctorReceipt = (resultPath: string) =>
          writeDoctorRollbackReceipt({
            change,
            configPath,
            resultPath,
            authored,
            originalRaw,
            operatorEdit,
          });
        const settledFailure = new Error("Doctor command failed after its config write settled.");
        if (change === "doctor-settled-exception") {
          vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementationOnce(
            async (_argv, options) => {
              assert(typeof options === "object");
              const resultPath = options.env?.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH;
              assert(resultPath);
              await writeDoctorReceipt(resultPath);
              throw settledFailure;
            },
          );
        } else {
          vi.spyOn(updateShared, "runUpdateStep").mockImplementationOnce(async (step) => {
            const resultPath = step.env?.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH;
            assert(resultPath);
            const doctorError = await writeDoctorReceipt(resultPath);
            return {
              name: "openclaw doctor",
              command: "doctor",
              cwd: candidateRoot,
              durationMs: 1,
              exitCode: doctorError ? 1 : 0,
              ...(doctorError ? { stderrTail: doctorError.message } : {}),
            };
          });
        }
        const runDoctor = () =>
          packageModule.runPackageUpdateDoctor({
            root: candidateRoot,
            timeoutMs: 1_000,
            progress: {},
            managedServiceEnv: process.env,
            onConfigSnapshot: (snapshot) => {
              // The migrated finalizer receives this snapshot through JSON IPC.
              const finalizerInput = JSON.stringify(snapshot);
              activationConfig = JSON.parse(finalizerInput);
            },
          });
        const doctorStep =
          change === "doctor-settled-exception"
            ? await runPackagePostInstallVerification(candidateRoot, runDoctor)
            : await runDoctor();
        if (change === "doctor-settled-exception" || change === "doctor-compensated") {
          assert(doctorStep, "Doctor failure did not return an update step");
          const settled = change === "doctor-settled-exception";
          expect(doctorStep).toMatchObject({
            ...(settled ? { name: "post-install-verify" } : {}),
            exitCode: 1,
            stderrTail: expect.stringContaining(
              settled ? settledFailure.message : "Doctor runtime activation refused",
            ),
          });
          if (settled) {
            result.reason = "runtime-verification-failed";
          } else {
            expect(doctorStep.advisory).toBeUndefined();
          }
          result.steps.push(doctorStep);
        }
        expect(fs.readFileSync(`${configPath}.pre-update`, "utf8")).toBe(originalRaw);
        const inspected = { ...result, status: "ok" as const };
        expect(
          await inspectActivatedUpdateState({
            result: inspected,
            root: candidateRoot,
            schemaVersions,
            candidateSchemaVersions: { state: change === "new-shared-deferred" ? 8 : 7, agent: 3 },
            config,
            env: process.env,
          }),
        ).toBeUndefined();
        expect(inspected.status).toBe("ok");
        if (change === "doctor-include-edit" || change === "doctor-include-owned-edit") {
          fs.writeFileSync(includePath, '{"level":"debug"}\n');
        }
        if (change === "doctor-include-owned-alias-edit") {
          const replacement = path.join(stateDir, "logging-replacement.json");
          fs.copyFileSync(includeTarget, replacement);
          fs.unlinkSync(includePath);
          fs.symlinkSync(replacement, includePath);
        }
        if (change === "doctor-operator-edit") {
          operatorEdit();
        }
        if (change === "doctor-stop-edit") {
          mocks.stop.mockImplementationOnce(async () => {
            operatorEdit();
            return { stopped: true, inspected: true, runtimeInspected: true, running: false };
          });
        }
      }
      const rollback = vi.fn(async () => {
        if (change === "doctor-restore-edit") {
          operatorEdit();
        }
        return restoredStep();
      });
      if (change === "identity-read-failed") {
        vi.spyOn(packageIdentity, "readPackageUpdateIdentity").mockRejectedValueOnce(
          new Error("Diagnostic identity read failed after verified restoration"),
        );
      }
      let finishWriter: (() => Promise<void>) | undefined;
      if (change === "doctor-locked-edit") {
        const script = path.join(candidateRoot, "config-writer.mjs");
        fs.writeFileSync(
          script,
          `
          import { withFileLock } from ${JSON.stringify(pathToFileURL(path.resolve("src/infra/file-lock.ts")).href)};
          import { appendFile } from "node:fs/promises";
          const commit = new Promise(resolve => process.once("message", resolve));
          await withFileLock(process.argv[2], {
            retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 }, stale: 30_000,
          }, async () => {
            process.send("locked");
            await commit;
            await appendFile(process.argv[2], "\\n// Operator edit after activation.\\n");
          });
          process.disconnect();
        `,
        );
        const writer = fork(script, [configPath], {
          execArgv: ["--import", path.resolve("scripts/tsx.mjs")],
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        });
        onTestFinished(() => stopChildProcess(writer, 1_000));
        const exited = once(writer, "exit");
        let requested = false;
        finishWriter = async () => {
          if (!requested && writer.connected) {
            requested = true;
            writer.send("commit");
          }
          const [code] = await exited;
          expect(code).toBe(0);
        };
        await Promise.race([
          once(writer, "message").then(([message]) => expect(message).toBe("locked")),
          exited.then(([code]) => {
            throw new Error(`Config writer exited before locking: ${code}`);
          }),
        ]);
        const open = fs.promises.open.bind(fs.promises);
        const rename = fs.promises.rename.bind(fs.promises);
        const lockPath = `${fs.realpathSync(configPath)}.lock`;
        // Commit at lock contention, or at an unprotected publication after its
        // final read. The operator holds the same cross-process lock as config set.
        vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
          if (String(args[0]) === lockPath) {
            await finishWriter?.();
          }
          return open(...args);
        });
        vi.spyOn(fs.promises, "rename").mockImplementation(async (...args) => {
          if (String(args[1]) === configPath) {
            await finishWriter?.();
          }
          return rename(...args);
        });
      }
      if (change === "readonly-config") {
        fs.chmodSync(stateDir, 0o500);
      }
      let outcome: Awaited<ReturnType<typeof rollbackFailedUpdate>>;
      try {
        outcome = await runRollback({
          result,
          nodeRunner: process.execPath,
          configSnapshot,
          activationConfig,
          schemaVersions,
          candidateSchemaVersions: { state: change === "new-shared-deferred" ? 8 : 7, agent: 3 },
          previousSchemaVersions:
            change === "new-agent-previous-unknown"
              ? undefined
              : {
                  state: 7,
                  agent: change === "new-agent-previous-incompatible" ? 2 : 3,
                },
          previousVerified,
          packageTransaction: { backupRoot: "/backup", rollback, complete: vi.fn() },
          opts: { json: true, restart: service !== "no-restart" },
          preManagedServiceStop:
            service === "absent"
              ? undefined
              : stoppedService({
                  stopped: service === "stopped",
                  serviceNodeRunner: "/previous/node",
                  serviceUpdateVerdict: {
                    kind: "owned",
                    root: previousRoot,
                    fingerprint: "fixture",
                    refreshDefinition: true,
                  },
                }),
        });
      } finally {
        await finishWriter?.();
        if (change === "readonly-config") {
          const mode = fs.statSync(stateDir).mode & 0o777;
          fs.chmodSync(stateDir, 0o700);
          expect(mode).toBe(0o500);
        }
      }
      if (change === "readonly-config") {
        expect(rollback).toHaveBeenCalledOnce();
        expect(fs.readFileSync(configPath, "utf8")).toBe(originalRaw);
      }
      if (change.startsWith("doctor") && restored) {
        expect(fs.readFileSync(configPath, "utf8")).toBe(originalRaw);
        if (process.platform !== "win32") {
          expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
        }
      }
      if (change === "doctor-include-owned" || change === "doctor-include-owned-alias") {
        expect(fs.readFileSync(includePath, "utf8")).toBe('{"level":"info"}\n');
      }
      if (includeAlias) {
        expect(fs.lstatSync(includePath).isSymbolicLink()).toBe(true);
      }
      if (change.startsWith("doctor-") && change.endsWith("edit")) {
        if (change === "doctor-input-edit") {
          expect(fs.readFileSync(configPath, "utf8")).toContain('"debug"');
        } else if (change === "doctor-include-owned-alias-edit") {
          expect(fs.readFileSync(includePath, "utf8")).toContain('"warn"');
          expect(fs.readFileSync(includeTarget, "utf8")).toContain('"warn"');
        } else if (change === "doctor-include-edit" || change === "doctor-include-owned-edit") {
          expect(fs.readFileSync(includePath, "utf8")).toContain('"debug"');
        } else {
          expect(fs.readFileSync(configPath, "utf8")).toContain("Operator edit after activation");
        }
        expect(
          resolveUpdateResultNextAction({ result: outcome.result, env: process.env }),
        ).toContain(configPath);
      }
      expect(outcome.rolledBack, JSON.stringify(outcome)).toBe(restored);
      expect(rollback, JSON.stringify(outcome)).toHaveBeenCalledTimes(
        restored || change === "none" || change === "doctor-restore-edit" ? 1 : 0,
      );
      expect(mocks.restart).toHaveBeenCalledTimes(restored ? 1 : 0);
      if (service !== "stopped") {
        expect(mocks.stop).not.toHaveBeenCalled();
        expect(outcome.result).toMatchObject({
          root: previousRoot,
          after: result.before,
          reason: result.reason,
          recovery: { serviceRestartSafe: false, packageRollbackVerified: true },
        });
        return;
      }
      if (restored) {
        expect(outcome).toMatchObject({ verifiedAtMs: 125 });
        expect(mocks.restart).toHaveBeenCalledWith(
          expect.objectContaining({ nodeRunner: "/previous/node" }),
        );
        expect(outcome.result).toMatchObject({
          root: previousRoot,
          after: result.before,
          reason:
            change === "doctor-settled-exception"
              ? "runtime-verification-failed"
              : change === "doctor-compensated"
                ? "doctor-failed"
                : "version-mismatch",
        });
        if (change === "doctor-settled-exception") {
          expect(activationConfig).toMatchObject({ raw: originalRaw, doctorOwned: true });
        }
        if (change === "doctor-compensated") {
          expect(activationConfig).toMatchObject({
            path: configPath,
            raw: originalRaw,
            hash: hashConfigRaw(originalRaw),
            doctorOwned: true,
          });
          expect(outcome.result).toMatchObject({
            status: "error",
            recovery: { serviceRestartSafe: true, packageRollbackVerified: true },
          });
        }
        expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
          rollback.mock.invocationCallOrder[0]!,
        );
        expect(rollback.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.restart.mock.invocationCallOrder[0]!,
        );
      } else {
        expect(outcome.result.reason).toBe(
          change === "unknown-runtime" ||
            change === "new-shared-deferred" ||
            change.startsWith("new-agent-previous-")
            ? "rollback-state-unverified"
            : previousVerified
              ? "state-migrated-no-rollback"
              : "previous-version-unverified",
        );
        if (!previousVerified) {
          expect(outcome.result).toMatchObject({ root: previousRoot, after: result.before });
        }
        if (change.startsWith("new-agent-previous-")) {
          expect(outcome.result).toMatchObject({ root: candidateRoot, after: result.after });
          expect(mocks.stop).not.toHaveBeenCalled();
        }
      }
    },
  );

  it("excludes a competing config writer across package rollback and config restoration", async () => {
    const stateDir = serviceStateDir;
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const configPath = path.join(stateDir, "openclaw.json");
    const original = '{"gateway":{"mode":"local","port":19101}}\n';
    const candidate = '{"gateway":{"mode":"local","port":19102}}\n';
    fs.writeFileSync(configPath, original);
    const { configSnapshot, schemaVersions } = await readRollbackFixtureState(stateDir, env);
    fs.writeFileSync(configPath, candidate);
    if (process.platform !== "win32") {
      fs.chmodSync(stateDir, 0o2770);
    }
    const lockOptions = {
      retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 },
      stale: 60_000,
    };
    let foreignWrite = false;
    const outcome = await runRollback({
      configSnapshot,
      schemaVersions,
      activationConfig: {
        path: configPath,
        raw: original,
        hash: hashConfigRaw(candidate),
        doctorOwned: true,
      },
      preManagedServiceStop: stoppedService({
        running: false,
        stopped: false,
        serviceEnv: env,
      }),
      packageTransaction: {
        backupRoot: previousRoot,
        complete: async () => {},
        rollback: async () => {
          const write = withFileLock(configPath, lockOptions, async () => {
            foreignWrite = true;
            fs.writeFileSync(configPath, '{"gateway":{"mode":"local","port":19103}}\n');
          });
          await expect(write).rejects.toBeInstanceOf(Error);
          await expect(write).rejects.toHaveProperty("code", FILE_LOCK_TIMEOUT_ERROR_CODE);
          return restoredStep("package rollback");
        },
      },
    });
    expect(foreignWrite).toBe(false);
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    if (process.platform !== "win32") {
      expect(fs.statSync(stateDir).mode & 0o7777).toBe(0o2770);
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    }
    expect(outcome.result).toMatchObject({
      root: previousRoot,
      recovery: { packageRollbackVerified: true },
    });
    expect(mocks.restart).not.toHaveBeenCalled();
    await withFileLock(configPath, lockOptions, async () => {
      fs.writeFileSync(configPath, candidate);
    });
    expect(fs.readFileSync(configPath, "utf8")).toBe(candidate);
  });

  it("leaves the original task recovery with finalization when rollback is blocked", async () => {
    const complete = vi.fn(async () => {});
    const stopped = {
      stopped: true,
      windowsTaskAutoStartRecovery: {
        suspended: Promise.resolve(true),
        handoff: () => {},
        beginMutation: () => {},
        assertRecoveryCurrent: () => {},
        restore: vi.fn(async () => {}),
        complete,
        interrupted: () => false,
      },
    };
    const outcome = await runRollback({
      result: failedCandidate({ before: undefined, after: undefined }),
      rollbackBlockedReason: "state-migrated-no-rollback",
      configSnapshot: await createConfigIO({
        env: { OPENCLAW_STATE_DIR: dirs.make("rollback-blocked-config-") },
        pluginValidation: "skip",
      }).readConfigFileSnapshot(),
      preManagedServiceStop: stoppedService({
        serviceEnv: { OPENCLAW_STATE_DIR: dirs.make("rollback-finalization-") },
        windowsTaskAutoStartRecovery: stopped.windowsTaskAutoStartRecovery,
      }),
    });
    expect(outcome).toMatchObject({ rolledBack: false });
    expect(outcome.stoppedForRollback).toBeUndefined();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it.each([
    "partial-restore",
    "restart-unhealthy",
    "restart-refused",
    "restart-threw",
    "restart-cleanup",
    "restart-timeout",
  ] as const)("retains active installation identity after %s", async (failure) => {
    await expectActiveRollbackIdentity({
      failure,
      candidateRoot,
      previousRoot,
      stateDir: serviceStateDir,
      restart: mocks.restart,
    });
  });
});
