import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { isProcessAlive } from "../../test/helpers/process-wait.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as commands from "../process/exec.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import { captureUpdateCandidateDeadline } from "./update-candidate-state.test-support.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "./update-run-ledger.js";
import { renderUpdateRunReport } from "./update-run-report.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

it.each([
  { phase: "shared database snapshot", settled: false },
  { phase: "plugin inventory", settled: false },
  { phase: "shared database snapshot", settled: true },
])(
  "retains $phase cancellation diagnostics through worker settlement (settled=$settled)",
  async ({ phase, settled }) => {
    const root = await fs.realpath(tempDirs.make("snapshot-watchdog-"));
    const stateDir = path.join(root, "source");
    const env = { HOME: root, OPENCLAW_STATE_DIR: stateDir, TMPDIR: root };
    const worker = path.join(
      root,
      "dist",
      runtimeProcessEntrypoints.updateCandidateState.distWorkerPath,
    );
    const pidFile = path.join(root, "worker.pid");
    await fs.mkdir(path.dirname(worker), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ type: "module", version: "2026.10.10" }),
    );
    await fs.writeFile(path.join(root, "dist", "index.js"), "");
    await fs.writeFile(
      path.join(root, "dist", runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath),
      "",
    );
    await fs.writeFile(
      worker,
      `
      import fs from "node:fs";
      import path from "node:path";
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      const request = JSON.parse(input);
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      const emit = (progress) => fs.writeSync(2, "State schema progress: " + JSON.stringify(progress) + "\\n");
      emit({ phase: "shared database snapshot", path: path.join(request.stateDir, "state/openclaw.sqlite"),
        snapshot: { status: "completed", copiedPages: 3160, totalPages: 3160, copiedBytes: 12943360, elapsedMs: 190 } });
      if (${JSON.stringify(phase)} === "plugin inventory") emit({ phase: "plugin inventory", path: request.stateDir });
      if (${settled}) process.stdout.write(JSON.stringify({ databases: [], pluginBytes: 0, pluginPlan: "plugin-copy-plan.json" }));
      else setInterval(() => {}, 1000);
    `,
    );
    const entered = createDeferred();
    const exited = createDeferred();
    const execute = commands.runUtf8CommandWithTimeout;
    vi.spyOn(commands, "runUtf8CommandWithTimeout").mockImplementation((argv, options) => {
      if (typeof options === "number") {
        return execute(argv, options);
      }
      let output = "";
      return execute(argv, {
        ...options,
        onOutputChunk(chunk, stream) {
          options.onOutputChunk?.(chunk, stream);
          if (stream === "stderr") {
            output += chunk.toString();
            if (output.includes(`"phase":"${phase}"`)) {
              entered.resolve();
            }
          }
        },
      }).finally(() => exited.resolve());
    });
    const expire = captureUpdateCandidateDeadline();
    const controller = new AbortController();
    const pendingReceipt = createDeferred();
    const progress: string[] = [];
    const operation = validateUpdateCandidateCanary({
      root,
      stateDir,
      env,
      config: {},
      signal: controller.signal,
      onProgress: (step) => {
        progress.push(step.detail ?? "");
        // Model the progress writer still settling after the completed shared copy.
        if (phase === "shared database snapshot" && step.detail?.includes("completed")) {
          return pendingReceipt.promise;
        }
        return undefined;
      },
    });
    try {
      await Promise.race([
        entered.promise,
        operation.then(() => {
          throw new Error("Worker never entered the stalled phase");
        }),
      ]);
      if (settled) {
        await exited.promise;
        // Drain the command's promise chain so only its progress receipt remains.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 400_000);
      if (settled) {
        controller.abort(new Error("Update validation deadline expired during progress recording"));
      } else {
        expire();
      }
      pendingReceipt.resolve();
      const result = await operation;
      clock.mockRestore();
      expect(result).toMatchObject({
        status: "error",
        phase: "snapshot",
        reason: "candidate-snapshot-failed",
      });
      if (result.status !== "error") {
        throw new Error("Expected the watchdog to stop snapshot validation");
      }
      expect(progress.join("\n")).toContain(phase);
      const failed = result.steps.find((step) => step.name === "candidate-state-snapshot");
      expect(failed?.stderrTail).toContain(`during ${phase}`);
      expect(failed?.stderrTail).toContain("3160/3160 pages");
      expect(failed?.stderrTail).toContain("12,943,360 bytes");
      expect(failed?.stderrTail).toContain("0.190 seconds");
      if (!settled) {
        expect(failed?.stderrTail).toContain("total estimated snapshot input");
      }
      expect(failed?.stderrTail).toMatch(/Last progress \d+\.\d+ seconds ago/);
      expect(failed?.stderrTail).toContain(
        settled ? "Update validation deadline expired" : "exceeded its 300 second allowance",
      );
      expect(failed?.stderrTail).not.toContain(root);
      const run = createUpdateRun({ trigger: "cli" }, { env });
      for (const step of result.steps.flatMap(updateRunStepsFromResultStep)) {
        recordUpdateRunStep(run.runId, step, { env });
      }
      finishUpdateRun(run.runId, { status: "failed", reason: result.reason }, { env });
      const saved = getUpdateRun(run.runId, { env });
      expect(
        saved?.steps.find((step) => step.step === "candidate-state-snapshot")?.stderrTail,
      ).toEqual(failed?.stderrTail);
      const report = renderUpdateRunReport(saved!).markdown;
      expect(report).toContain(phase);
      expect(report).toContain("12,943,360 bytes");
      if (!settled) {
        expect(report).toContain("total estimated snapshot input");
      }
      expect(isProcessAlive(Number(await fs.readFile(pidFile, "utf8")))).toBe(false);
      expect(
        (await fs.readdir(root)).filter((entry) => entry.startsWith("openclaw-update-canary-")),
      ).toEqual([]);
    } finally {
      controller.abort();
      pendingReceipt.resolve();
      await operation;
    }
  },
);
