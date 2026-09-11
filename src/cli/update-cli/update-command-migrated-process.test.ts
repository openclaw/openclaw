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
import { killPidIfAlive, waitForPidToExit } from "../../test-utils/process-tree.js";
import { runUpdateFinalizationDoctorInFreshProcess } from "./update-command-fresh-doctor.js";
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

it("settles a failed Doctor's descendants before recovery can observe its result", async () => {
  const root = await fs.realpath(dirs.make("doctor-descendant-recovery-"));
  const marker = path.join(root, "late-mutation.txt");
  const pidFile = path.join(root, "descendant.pid");
  const entryPath = path.join(root, "doctor-fixture.mjs");
  const descendant = `
    const fs = require("node:fs");
    process.on("SIGTERM", () => {});
    setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, "late mutation"); process.exit(0); }, 800);
    process.send("ready");
  `;
  await fs.writeFile(
    entryPath,
    `
    import { spawn } from "node:child_process";
    import fs from "node:fs";
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    child.once("message", () => {
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      child.disconnect();
      process.stderr.write("synthetic Doctor failure\\n");
      process.exit(1);
    });
  `,
  );
  let descendantPid: number | undefined;
  try {
    await expect(
      runUpdateFinalizationDoctorInFreshProcess({
        root,
        entryPath,
        phase: "pre-plugin",
        yes: true,
        json: true,
        nodeRunner: process.execPath,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("synthetic Doctor failure");
    descendantPid = Number(await fs.readFile(pidFile, "utf8"));
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(await waitForPidToExit(descendantPid)).toBe(true);
    await expect(fs.readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    descendantPid ??= Number(await fs.readFile(pidFile, "utf8").catch(() => ""));
    if (Number.isSafeInteger(descendantPid) && descendantPid > 0) {
      killPidIfAlive(descendantPid);
      await waitForPidToExit(descendantPid);
    }
  }
});
