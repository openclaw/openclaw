import fs from "node:fs";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import {
  createConfigIO,
  setRuntimeConfigSnapshotRefreshHandler,
  transformConfigFile,
  writeConfigFile,
} from "../../config/config.js";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import type { ConfigWriteOptions } from "../../config/io.types.js";
import type {
  AgentDefaultsConfig,
  ConfigFileSnapshot,
  OpenClawConfig,
} from "../../config/types.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import {
  captureUpdateDoctorConfigWrites,
  writeUpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { updateRecoverySchema } from "../../infra/update-recovery.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import { printResult } from "./progress.js";
import type { UpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import { completeUpdateCommandRun } from "./update-command-run.js";

export function writeDoctorRollbackConfig(stateDir: string, change: string) {
  const configPath = path.join(stateDir, "openclaw.json");
  const includePath = path.join(stateDir, "logging.json");
  const includeTarget = path.join(stateDir, "logging-original.json");
  const authored = {
    gateway: { mode: "local" },
    agents: { defaults: { models: { "openai/gpt-5.6-luna": {} } } },
    ...(change.startsWith("doctor-include") ? { logging: { $include: "./logging.json" } } : {}),
  };
  const originalRaw = `// Fresh install: Doctor has never run.\n${JSON.stringify(authored, null, 2)}\n`;
  if (change.startsWith("doctor-include")) {
    const alias = change.startsWith("doctor-include-owned-alias");
    fs.writeFileSync(alias ? includeTarget : includePath, '{"level":"info"}\n');
    if (alias) {
      fs.symlinkSync(includeTarget, includePath);
    }
  }
  if (change.startsWith("doctor") || change === "readonly-config") {
    fs.writeFileSync(configPath, originalRaw, { mode: 0o600 });
  }
  return { configPath, includePath, includeTarget, authored, originalRaw };
}

export async function writeDoctorRollbackReceipt(params: {
  change: string;
  configPath: string;
  resultPath: string;
  authored: { agents: { defaults: AgentDefaultsConfig } };
  originalRaw: string;
  operatorEdit: () => void;
}): Promise<Error | undefined> {
  const { change, configPath, resultPath, authored, originalRaw, operatorEdit } = params;
  let doctorError: Error | undefined;
  if (change === "doctor-input-edit") {
    fs.writeFileSync(configPath, JSON.stringify({ ...authored, logging: { level: "debug" } }));
  }
  await captureUpdateDoctorConfigWrites(configPath, async (capture) => {
    const io = createConfigIO({ env: process.env, pluginValidation: "skip" });
    const input = await io.readConfigFileSnapshot();
    if (change.startsWith("doctor-include-owned")) {
      await transformConfigFile({
        transform: (config) => ({
          nextConfig: { ...config, logging: { ...config.logging, level: "warn" } },
        }),
        writeOptions: { skipPluginValidation: true, auditOrigin: "doctor" },
      });
      expect(fs.readFileSync(configPath, "utf8")).toBe(originalRaw);
    } else if (change !== "doctor-unchanged") {
      const nextConfig: OpenClawConfig = {
        ...(input.sourceConfigBeforeMigrations ?? input.sourceConfig),
        meta: {
          migrations: { modelPolicyAllowlist: true },
          lastTouchedVersion: "2026.9.3",
        },
        agents: {
          defaults: {
            ...authored.agents.defaults,
            modelPolicy: { allow: ["openai/gpt-5.6-luna"] },
          },
        },
        wizard: { lastRunVersion: "2026.9.3", lastRunCommand: "doctor" },
      };
      const writeOptions = {
        baseSnapshot: input,
        lastTouchedVersionOverride: "2026.9.3",
        skipPluginValidation: true,
      };
      if (change === "doctor-compensated") {
        doctorError = await writeWithRefreshFailure(nextConfig, writeOptions, originalRaw);
      } else {
        await io.writeConfigFile(nextConfig, writeOptions);
      }
    }
    if (change === "doctor-capture-edit") {
      operatorEdit();
    }
    if (change === "doctor-settled-exception") {
      expect(capture.inputHash).toBe(hashConfigRaw(originalRaw));
      expect(capture.hash).toBe(hashConfigRaw(fs.readFileSync(configPath, "utf8")));
      expect(capture.hash).not.toBe(capture.inputHash);
    }
    await writeUpdatePostInstallDoctorResult({
      resultPath,
      result: {
        status: doctorError ? "error" : "ok",
        configHash: capture.hash,
        ...(change === "doctor-missing-input" ? {} : { configInputHash: capture.inputHash }),
        ...(capture.fileWrites ? { configFileWrites: capture.fileWrites } : {}),
      },
    });
  });
  return doctorError;
}

async function writeWithRefreshFailure(
  nextConfig: OpenClawConfig,
  writeOptions: ConfigWriteOptions & { baseSnapshot: ConfigFileSnapshot },
  originalRaw: string,
): Promise<Error> {
  const configPath = writeOptions.baseSnapshot.path;
  let doctorError: Error | undefined;
  setRuntimeConfigSnapshotRefreshHandler({
    preflight: () => undefined,
    refresh: () => {
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toMatchObject({
        meta: { migrations: { modelPolicyAllowlist: true } },
        wizard: { lastRunCommand: "doctor" },
      });
      throw new Error("Doctor runtime activation refused");
    },
  });
  try {
    await writeConfigFile(nextConfig, writeOptions);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    doctorError = error;
  } finally {
    setRuntimeConfigSnapshotRefreshHandler(null);
  }
  if (!doctorError) {
    throw new Error("Doctor config write completed without the expected refresh failure");
  }
  expect(doctorError).toMatchObject({
    name: "ConfigWritePostCommitError",
    configPath,
    rollbackStatus: "restored",
  });
  expect(fs.readFileSync(configPath, "utf8")).toBe(originalRaw);
  return doctorError;
}

export function expectDoctorRollback(
  activationConfig: UpdateConfigSnapshot | undefined,
  result: UpdateRunResult,
  configPath: string,
  originalRaw: string,
): void {
  expect(activationConfig).toMatchObject({
    path: configPath,
    raw: originalRaw,
    hash: hashConfigRaw(originalRaw),
    doctorOwned: true,
  });
  expect(result).toMatchObject({
    status: "error",
    recovery: { serviceRestartSafe: true, packageRollbackVerified: true },
  });
}

export async function expectActiveRollbackIdentity(params: {
  failure: string;
  candidateRoot: string;
  previousRoot: string;
  stateDir: string;
  restart: Mock<typeof import("./update-command-service.js").maybeRestartService>;
}): Promise<void> {
  const { failure, candidateRoot, previousRoot, stateDir, restart } = params;
  const restoredPackage = failure !== "source-failed" && failure !== "partial-restore";
  const rollbackSucceeded = failure.startsWith("restart-");
  const activePackageRoot =
    failure === "partial-restore" ? null : restoredPackage ? previousRoot : candidateRoot;
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const configSnapshot = await createConfigIO({
    env,
    pluginValidation: "skip",
  }).readConfigFileSnapshot();
  const config = configSnapshot.sourceConfigBeforeMigrations ?? configSnapshot.sourceConfig;
  const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config, env });
  const result: UpdateRunResult = {
    status: "error",
    mode: "npm",
    root: candidateRoot,
    reason: "readyz-unhealthy",
    steps: [],
    durationMs: 1,
    before: { version: "2026.9.1" },
    after: { version: "2026.9.3" },
  };
  const cleanup = new AggregateError(
    [new CommandProcessCleanupError()],
    "rollback inspection cleanup uncertain",
  );
  if (failure === "restart-cleanup") {
    restart.mockRejectedValueOnce(cleanup);
  } else if (failure === "restart-threw") {
    restart.mockRejectedValueOnce(new Error("Service restart transport failed"));
  } else {
    restart.mockImplementationOnce(async ({ onVerificationFailure }) => {
      if (failure === "restart-unhealthy") {
        onVerificationFailure?.("channel-errors");
        return "restart-health-failed";
      }
      return failure === "restart-timeout"
        ? "readiness-pending"
        : failure === "restart-verified"
          ? "ok"
          : "failed";
    });
  }
  const pending = rollbackFailedUpdate({
    definitionRecovery: {},
    result,
    previousRoot,
    configSnapshot,
    opts: { json: true },
    timeoutMs: 1_000,
    schemaVersions,
    previousVerified: true,
    preManagedServiceStop: {
      stopped: true,
      inspected: true,
      runtimeInspected: true,
      running: true,
      serviceEnv: env,
    },
    packageTransaction: {
      backupRoot: "/backup",
      complete: vi.fn(async () => {}),
      rollback: vi.fn(async () => ({
        name: "rollback",
        activePackageRoot,
        command: "restore",
        cwd: previousRoot,
        exitCode: rollbackSucceeded ? 0 : 1,
        durationMs: 1,
      })),
    },
  });
  if (failure === "restart-cleanup") {
    await expect(pending).rejects.toBe(cleanup);
    return;
  }
  const outcome = await pending;
  expect(outcome.result).toMatchObject({
    root: activePackageRoot ?? undefined,
    after: activePackageRoot === null ? undefined : restoredPackage ? result.before : result.after,
    reason: rollbackSucceeded ? result.reason : "source-rollback-failed",
    rollbackOutcome: { status: rollbackSucceeded ? "succeeded" : "failed" },
    steps: [
      expect.objectContaining({
        name: "rollback",
        exitCode: rollbackSucceeded ? 0 : 1,
      }),
    ],
    ...(!rollbackSucceeded
      ? {}
      : {
          recovery: { serviceRestartSafe: true, packageRollbackVerified: true },
        }),
  });
  expect(outcome.rolledBack).toBe(failure === "restart-verified");
  expect(restart).toHaveBeenCalledTimes(rollbackSucceeded ? 1 : 0);
  if (rollbackSucceeded) {
    const report = await prepareUpdateFailureReport(
      {
        attemptId: "rollback-health-verdict",
        result: {
          ...outcome.result,
          recovery: updateRecoverySchema.parse(outcome.result.recovery),
        },
      },
      { env, stateDir },
    );
    const health =
      failure === "restart-unhealthy"
        ? "failed (channel-errors)"
        : failure === "restart-timeout"
          ? "unverified (gateway-readiness-pending)"
          : failure === "restart-refused"
            ? "unverified (restart-failed)"
            : "unverified (gateway-verification-incomplete)";
    expect(report.body).toContain(
      failure === "restart-verified"
        ? "Recovery outcome: package rollback verified; Gateway serving 2026.9.1; health verified"
        : `Recovery outcome: package rollback verified (2026.9.1); Gateway health ${health}. Run \`openclaw gateway status --deep\``,
    );
  }
}

export function registerRollbackReportTests(
  getFixture: () => { candidateRoot: string; previousRoot: string; stateDir: string },
) {
  it.each(["advisory", "failed", "thrown"] as const)(
    "reports retained rollback %s through JSON, history, and human output",
    async (outcome) => {
      const { candidateRoot, previousRoot, stateDir } = getFixture();
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const configSnapshot = await createConfigIO({
        env,
        pluginValidation: "skip",
      }).readConfigFileSnapshot();
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      const schemaVersions = await readUpdateStateSchemaVersions({
        stateDir,
        config: configSnapshot.sourceConfigBeforeMigrations ?? configSnapshot.sourceConfig,
        env,
      });
      const message =
        outcome === "advisory"
          ? "Restored detached HEAD; branch main still points to the activated commit."
          : `Cannot verify rollback branch transition: expected ${"a".repeat(40)} -> ${"b".repeat(40)}.`;
      const restored = {
        name: "git-runtime-rollback",
        command: "restore previous Git runtime",
        cwd: previousRoot,
        durationMs: 0,
        exitCode: outcome === "advisory" ? 0 : 1,
        ...(outcome === "advisory"
          ? { advisory: { kind: "recoverable-maintenance" as const, message } }
          : { stderrTail: message }),
      };
      const rolledBack = await rollbackFailedUpdate({
        definitionRecovery: {},
        result: {
          status: "error",
          mode: "git",
          root: candidateRoot,
          reason: "readyz-unhealthy",
          verification: { readyz: false, settled: false },
          steps: [],
          durationMs: 1,
        },
        previousRoot,
        schemaVersions,
        configSnapshot,
        opts: { json: true, run },
        timeoutMs: 1_000,
        packageTransaction: {
          backupRoot: previousRoot,
          complete: async () => {},
          rollback: async () => {
            if (outcome === "thrown") {
              throw new Error(message);
            }
            return { ...restored, activePackageRoot: previousRoot };
          },
        },
      });
      expect(getUpdateRun(run.runId, { env })?.steps).toContainEqual(
        expect.objectContaining({ step: "package rollback", detail: message }),
      );
      const result = completeUpdateCommandRun(rolledBack.result, run);
      const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      await printResult(result, { json: true, run });
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          ...(outcome === "thrown" ? {} : { steps: expect.arrayContaining([restored]) }),
          run: expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({
                step: outcome === "advisory" ? "warning:git-runtime-rollback" : "package rollback",
                detail: message,
              }),
            ]),
          }),
        }),
      );
      await printResult(result, { run });
      expect(log).toHaveBeenCalledWith(expect.stringContaining(message));
    },
  );
}
