import fs from "node:fs";
import path from "node:path";
import { assert, expect, it, vi, type Mock } from "vitest";
import {
  createConfigIO,
  setRuntimeConfigSnapshotRefreshHandler,
  transformConfigFile,
  writeConfigFile,
} from "../../config/config.js";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import type { AgentDefaultsConfig, OpenClawConfig } from "../../config/types.js";
import { readUpdateStateSchemaVersionsInProcess } from "../../infra/update-candidate-state.js";
import {
  captureUpdateDoctorConfigWrites,
  writeUpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { updateRecoverySchema } from "../../infra/update-recovery.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { printResult } from "./progress.js";
import { resultFixture, stepFixture } from "./update-command-fixtures.test-support.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import { completeUpdateCommandRun } from "./update-command-run.js";

type SchemaInput = Parameters<typeof readUpdateStateSchemaVersionsInProcess>[0];
const doctorMetadata = {
  meta: { migrations: { modelPolicyAllowlist: true }, lastTouchedVersion: "2026.9.3" },
  wizard: { lastRunVersion: "2026.9.3", lastRunCommand: "doctor" },
} satisfies Pick<OpenClawConfig, "meta" | "wizard">;

export async function readRollbackFixtureSchemaVersions(
  input: Pick<SchemaInput, "stateDir" | "config" | "env">,
) {
  // Config and ledger setup can retain SQLite handles. Drain them before the
  // fixture reader closes source descriptors; candidate checks stay isolated.
  await closeOpenClawStateDatabaseAsync();
  return readUpdateStateSchemaVersionsInProcess({ ...input, env: input.env ?? process.env });
}

export async function readRollbackFixtureState(
  stateDir: string,
  env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: stateDir },
) {
  const io = createConfigIO({ env, pluginValidation: "skip" });
  const configSnapshot = await io.readConfigFileSnapshot();
  const schemaVersions = await readRollbackFixtureSchemaVersions({
    stateDir,
    config: configSnapshot.sourceConfigBeforeMigrations ?? configSnapshot.sourceConfig,
    env,
  });
  return { configSnapshot, schemaVersions };
}

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
        ...doctorMetadata,
        agents: {
          defaults: {
            ...authored.agents.defaults,
            modelPolicy: { allow: ["openai/gpt-5.6-luna"] },
          },
        },
      };
      const writeOptions = {
        baseSnapshot: input,
        lastTouchedVersionOverride: "2026.9.3",
        skipPluginValidation: true,
      };
      if (change === "doctor-compensated") {
        const writtenPath = input.path;
        setRuntimeConfigSnapshotRefreshHandler({
          preflight: () => undefined,
          refresh: () => {
            expect(JSON.parse(fs.readFileSync(writtenPath, "utf8"))).toMatchObject(doctorMetadata);
            throw new Error("Doctor runtime activation refused");
          },
        });
        try {
          const error = await writeConfigFile(nextConfig, writeOptions).catch(
            (cause: unknown) => cause,
          );
          expect(error).toMatchObject({
            name: "ConfigWritePostCommitError",
            configPath: writtenPath,
            rollbackStatus: "restored",
          });
          expect(fs.readFileSync(writtenPath, "utf8")).toBe(originalRaw);
          assert(error instanceof Error, "Doctor must reject after its refresh failure");
          doctorError = error;
        } finally {
          setRuntimeConfigSnapshotRefreshHandler(null);
        }
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

export async function expectActiveRollbackIdentity(params: {
  failure:
    | "partial-restore"
    | `restart-${"unhealthy" | "refused" | "threw" | "cleanup" | "timeout"}`;
  candidateRoot: string;
  previousRoot: string;
  stateDir: string;
  restart: Mock<typeof import("./update-command-service.js").maybeRestartService>;
}): Promise<void> {
  const { failure, candidateRoot, previousRoot, stateDir, restart } = params;
  const rollbackSucceeded = failure !== "partial-restore";
  const activePackageRoot = rollbackSucceeded ? previousRoot : null;
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const { configSnapshot, schemaVersions } = await readRollbackFixtureState(stateDir, env);
  const result = resultFixture(candidateRoot, {
    status: "error",
    reason: "readyz-unhealthy",
    durationMs: 1,
    before: { version: "2026.9.1" },
    after: { version: "2026.9.3" },
  });
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
      return failure === "restart-timeout" ? "readiness-pending" : "failed";
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
        command: "restore",
        cwd: previousRoot,
        exitCode: rollbackSucceeded ? 0 : 1,
        durationMs: 1,
        activePackageRoot,
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
    after: rollbackSucceeded ? result.before : undefined,
    reason: rollbackSucceeded ? result.reason : "source-rollback-failed",
    rollbackOutcome: { status: rollbackSucceeded ? "succeeded" : "failed" },
    steps: [{ name: "rollback", exitCode: rollbackSucceeded ? 0 : 1 }],
    ...(rollbackSucceeded
      ? { recovery: { serviceRestartSafe: true, packageRollbackVerified: true } }
      : {}),
  });
  expect(outcome.rolledBack).toBe(false);
  expect(restart).toHaveBeenCalledTimes(rollbackSucceeded ? 1 : 0);
  if (failure !== "partial-restore") {
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
    const health = {
      "restart-unhealthy": "failed (channel-errors)",
      "restart-timeout": "unverified (gateway-readiness-pending)",
      "restart-refused": "unverified (restart-failed)",
      "restart-threw": "unverified (gateway-verification-incomplete)",
    }[failure];
    expect(report.body).toContain(
      `Recovery outcome: package rollback verified (2026.9.1); Gateway health ${health}. Run \`openclaw gateway status --deep\``,
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
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      const { configSnapshot, schemaVersions } = await readRollbackFixtureState(stateDir, env);
      const message =
        outcome === "advisory"
          ? "Restored detached HEAD; branch main still points to the activated commit."
          : `Cannot verify rollback branch transition: expected ${"a".repeat(40)} -> ${"b".repeat(40)}.`;
      const restored = stepFixture("git-runtime-rollback", {
        command: "restore previous Git runtime",
        cwd: previousRoot,
        exitCode: outcome === "advisory" ? 0 : 1,
        ...(outcome === "advisory"
          ? { advisory: { kind: "recoverable-maintenance" as const, message } }
          : { stderrTail: message }),
      });
      const rolledBack = await rollbackFailedUpdate({
        definitionRecovery: {},
        result: resultFixture(candidateRoot, {
          status: "error",
          mode: "git",
          reason: "readyz-unhealthy",
          verification: { readyz: false, settled: false },
          durationMs: 1,
        }),
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
      const result = completeUpdateCommandRun(rolledBack.result, run);
      const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      await printResult(result, { json: true, run });
      const printed = json.mock.calls[0]?.[0];
      if (outcome !== "thrown") {
        expect(printed).toMatchObject({
          steps: expect.arrayContaining([
            {
              ...restored,
              ...(outcome === "failed"
                ? { failureFacts: [{ check: "update", code: "source-rollback-failed" }] }
                : {}),
            },
          ]),
        });
      }
      expect(printed).toMatchObject({
        run: {
          steps: expect.arrayContaining([
            expect.objectContaining({
              step: outcome === "advisory" ? "warning:git-runtime-rollback" : "package rollback",
              detail: message,
            }),
          ]),
        },
      });
      await printResult(result, { run });
      expect(log).toHaveBeenCalledWith(expect.stringContaining(message));
    },
  );
}
