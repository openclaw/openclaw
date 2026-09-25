import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as jsonFiles from "../infra/json-files.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  createUpdateRun,
  finishUpdateRun as finishLedgerRun,
  getUpdateRun,
} from "../infra/update-run-ledger.js";
import { defaultRuntime } from "../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { finishUpdateRun, recordUpdateRunDiagnostic } from "./daemon-cli.js";
import { printResult } from "./update-cli/progress.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

function fixture() {
  const stateDir = tempDirs.make("openclaw-daemon-ledger-");
  const env = {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_WORKSPACE_DIR: path.join(stateDir, "workspace"),
  };
  const options = { env };
  const run = createUpdateRun({ trigger: "cli", target: { kind: "git" } }, options);
  const result = {
    status: "ok" as const,
    mode: "git" as const,
    steps: [],
    durationMs: 0,
    runId: run.runId,
  };
  const opts = { json: true, run: { runId: run.runId, env } };
  const reportPath = path.join(stateDir, "update-reports", `${run.runId}.md`);
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  return { stateDir, options, run, result, opts, reportPath };
}

function finishFromPublishedDriver(
  runId: string,
  outcome: { status: "failed"; reason: string },
  options: { env: NodeJS.ProcessEnv },
  contention?: { lockPath: string; observed: () => void },
): Promise<void> {
  const entry = resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "daemon-cli",
    distWorkerPath: "cli/daemon-cli.js",
  });
  // Published managed drivers call this stable export without awaiting it.
  // Their child exits naturally after the finalizer's filesystem work settles.
  const child = spawn(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(entry).slice(0, -1),
      "--input-type=module",
      "-e",
      `
        const lockPath = ${JSON.stringify(contention?.lockPath ?? null)};
        const { finishUpdateRun } = await import(${JSON.stringify(entry.href)});
        finishUpdateRun(${JSON.stringify(runId)}, ${JSON.stringify(outcome)}, ${JSON.stringify(options)});
        if (lockPath && (await import("node:fs")).existsSync(lockPath)) {
          process.stdout.write("REPORT_LOCK_PRESENT\\n");
        }
      `,
    ],
    { env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stdout.includes("REPORT_LOCK_PRESENT")) {
      contention?.observed();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0 || signal || stderr.includes("Update report could not be saved:")) {
        reject(new Error(`Published driver failed (${code}/${signal}): ${stderr}`));
      } else {
        resolve();
      }
    });
  });
}

it("exports the terminal-safe update diagnostic writer for installed-runtime finalization", async () => {
  const { options, run, reportPath } = fixture();
  await finishUpdateRun(run.runId, { status: "failed", reason: "post-update-failed" }, options);
  expect(await fs.readFile(reportPath, "utf8")).toContain(
    "OpenClaw update failed: post-update-failed",
  );

  recordUpdateRunDiagnostic(
    run.runId,
    "Gateway availability is unverified after failed settlement.",
    options,
    "warning:gateway-availability",
  );

  const saved = getUpdateRun(run.runId, options);
  expect(saved).toMatchObject({ status: "failed", reason: "post-update-failed" });
  expect(saved?.steps).toContainEqual(
    expect.objectContaining({ step: "warning:gateway-availability", status: "completed" }),
  );
});

it.each(["awaited", "published driver", "settled child"] as const)(
  "refreshes the foreground report after %s terminal settlement, preserving complete findings",
  async (driver) => {
    const { options, run, result, opts, reportPath } = fixture();
    const lintMessage = "Synthetic warning retained from candidate validation";
    await printResult(
      {
        ...result,
        steps: [
          {
            name: "candidate Doctor lint",
            command: "openclaw doctor --lint",
            cwd: "synthetic",
            durationMs: 1,
            exitCode: 0,
            doctorLintFindings: [
              { checkId: "core/config", severity: "warning", message: lintMessage },
            ],
          },
        ],
      },
      opts,
      { nextAction: "Update is not finished. Check progress: openclaw update status" },
    );
    expect(await fs.readFile(reportPath, "utf8")).toContain("in progress");
    const outcome = { status: "failed" as const, reason: "managed-service-handoff-failed" };
    const reason = driver === "settled child" ? "candidate-validation-failed" : outcome.reason;
    if (driver === "settled child") {
      // The child committed its verdict, then exited before replacing the report.
      finishLedgerRun(run.runId, { status: "failed", reason }, options);
    }
    if (driver !== "published driver") {
      await finishUpdateRun(run.runId, outcome, options);
    } else {
      await finishFromPublishedDriver(run.runId, outcome, options);
    }
    expect(getUpdateRun(run.runId, options)).toMatchObject({
      status: "failed",
      phase: "finished",
      reason,
      verification: {},
    });
    const saved = await fs.readFile(reportPath, "utf8");
    expect(saved).toContain(`OpenClaw update failed: ${reason}`);
    expect(saved).toContain("Run openclaw triage");
    expect(saved).toContain("Complete Doctor lint findings (1)");
    expect(saved).toContain(lintMessage);
    expect(saved).not.toContain("in progress");
    expect(saved).not.toContain("Update is not finished");
    expect(saved).not.toContain("The gateway is running");
  },
);

it("preserves a child-authored terminal report and its first recorded outcome", async () => {
  const { options, run, result, opts, reportPath } = fixture();
  await finishUpdateRun(
    run.runId,
    { status: "failed", reason: "candidate-validation-failed" },
    options,
  );
  await printResult({ ...result, status: "error", reason: "candidate-validation-failed" }, opts, {
    nextAction: "Keep this specific candidate diagnostic and inspect the failed check.",
  });
  const report = await fs.readFile(reportPath, "utf8");
  await finishUpdateRun(run.runId, { status: "succeeded" }, options);
  expect(getUpdateRun(run.runId, options)?.status).toBe("failed");
  expect(await fs.readFile(reportPath, "utf8")).toBe(report);
});

it("keeps durable failure when the report directory cannot be written", async () => {
  const { stateDir, options, run } = fixture();
  await fs.writeFile(path.join(stateDir, "update-reports"), "unrelated file");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(
    finishUpdateRun(
      run.runId,
      { status: "failed", reason: "managed-service-handoff-failed" },
      options,
    ),
  ).resolves.toMatchObject({ status: "failed" });
  expect(getUpdateRun(run.runId, options)?.status).toBe("failed");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Update report could not be saved:"));
  expect(await fs.readFile(path.join(stateDir, "update-reports"), "utf8")).toBe("unrelated file");
});

it("does not let an in-flight foreground report overwrite terminal settlement", async () => {
  const { options, run, result, opts, reportPath } = fixture();
  const paused = createDeferred();
  const release = createDeferred();
  const atomicWrite = jsonFiles.writeTextAtomic;
  let intercepted = false;
  vi.spyOn(jsonFiles, "writeTextAtomic").mockImplementation(async (target, body, policy) => {
    if (target !== reportPath || intercepted) {
      return atomicWrite(target, body, policy);
    }
    intercepted = true;
    return atomicWrite(target, body, {
      ...policy,
      beforeRename: async () => {
        paused.resolve();
        await release.promise;
      },
    });
  });
  const foreground = printResult(result, opts);
  await Promise.race([
    paused.promise,
    foreground.then(() => {
      throw new Error("Foreground report completed without reaching its atomic write gate");
    }),
  ]);
  const contended = createDeferred();
  const terminal = finishFromPublishedDriver(
    run.runId,
    { status: "failed", reason: "managed-service-handoff-failed" },
    options,
    { lockPath: `${reportPath}.lock`, observed: () => contended.resolve() },
  );
  try {
    // The child confirms settlement while the foreground holds the report lock.
    // Without serialization it exits first, then the stale rename wins.
    await Promise.race([terminal, contended.promise]);
  } finally {
    release.resolve();
    await Promise.all([foreground, terminal]);
  }
  const saved = await fs.readFile(reportPath, "utf8");
  expect(saved).toContain("OpenClaw update failed: managed-service-handoff-failed");
  expect(saved).not.toContain("in progress");
});
