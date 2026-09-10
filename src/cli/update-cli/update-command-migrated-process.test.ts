import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { MigratedUpdateFinalizationInput } from "./update-command-migrated-types.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseForTest);

it("returns migrated failure to the parent without terminalizing the run", async () => {
  const stateDir = await fs.realpath(dirs.make("migrated-worker-recovery-"));
  const env = {
    HOME: stateDir,
    USERPROFILE: stateDir,
    PATH: process.env.PATH,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_TEST_RUNTIME_LOG: "1",
  };
  const { runId } = createUpdateRun({ trigger: "cli" }, { env });
  closeOpenClawStateDatabaseForTest();
  const input: MigratedUpdateFinalizationInput = {
    params: {
      mutationStarted: true,
      root: process.cwd(),
      result: {
        status: "error",
        reason: "doctor-failed",
        mode: "npm",
        root: process.cwd(),
        steps: [],
        durationMs: 0,
      },
      installKindChanged: false,
      configSnapshot: {
        path: env.OPENCLAW_CONFIG_PATH,
        exists: false,
        raw: null,
        parsed: {},
        sourceConfig: asResolvedSourceConfig({}),
        resolved: asResolvedSourceConfig({}),
        valid: true,
        runtimeConfig: asRuntimeConfig({}),
        config: asRuntimeConfig({}),
        issues: [],
        warnings: [],
        legacyIssues: [],
      },
      requestedChannel: null,
      storedChannel: "stable",
      channel: "stable",
      downgradeRisk: false,
      shouldRestart: false,
      opts: { json: true, run: { runId, env } },
      controlPlaneUpdateSentinelMeta: null,
      preUpdatePluginInstallRecords: {},
      startedAt: Date.now(),
      updateStepTimeoutMs: 1_000,
      rollbackBlockedReason: "state-migrated-no-rollback",
      updateRecoveryBackup: {
        directory: path.join(stateDir, "update-recovery"),
        manifestPath: path.join(stateDir, "update-recovery", "manifest.json"),
        manifestSha256: "a".repeat(64),
      },
      deferFailureRecoveryToParent: true,
    },
    bufferedSteps: [{ step: "doctor", status: "failed", detail: "Injected migration failure" }],
    resultPath: path.join(stateDir, "worker-result.json"),
  };
  const child = await runUtf8CommandWithTimeout(
    [
      process.execPath,
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateMigratedFinalize),
      ),
    ],
    {
      cwd: process.cwd(),
      baseEnv: {},
      env,
      input: JSON.stringify(input),
      timeoutMs: 30_000,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
    },
  );
  expect(child, child.stderr).toMatchObject({ code: 0, cleanup: "normal" });
  expect(JSON.parse(await fs.readFile(input.resultPath, "utf8"))).toMatchObject({
    result: { status: "error", reason: "doctor-failed", runId },
    exitCode: 1,
    recoveryRequired: true,
  });
  expect(getUpdateRun(runId, { env })).toMatchObject({
    status: "running",
    steps: expect.arrayContaining([expect.objectContaining({ step: "doctor", status: "failed" })]),
  });
}, 40_000);
