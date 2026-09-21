import fs from "node:fs";
import { expect, vi, type Mock } from "vitest";
import {
  createConfigIO,
  setRuntimeConfigSnapshotRefreshHandler,
  writeConfigFile,
} from "../../config/config.js";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import type { ConfigWriteOptions } from "../../config/io.types.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { updateRecoverySchema } from "../../infra/update-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import type { UpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";

export async function writeWithRefreshFailure(
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
