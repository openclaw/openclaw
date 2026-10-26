import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { isProcessAlive } from "../../test/helpers/process-wait.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as commands from "../process/exec.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import { prepareUpdateCandidateStateSnapshot } from "./update-candidate-snapshot.js";
import { captureUpdateCandidateDeadline } from "./update-candidate-state.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

async function fixture(canary = false) {
  const root = await fs.realpath(tempDirs.make("snapshot-watchdog-"));
  const stateDir = path.join(root, "source");
  const env = { HOME: root, OPENCLAW_STATE_DIR: stateDir, TMPDIR: root };
  const dist = path.join(root, "dist");
  const worker = path.join(dist, runtimeProcessEntrypoints.updateCandidateState.distWorkerPath);
  await fs.mkdir(path.dirname(worker), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ type: "module", ...(canary ? { version: "2026.10.10" } : {}) }),
  );
  if (canary) {
    for (const file of [
      "index.js",
      runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
    ]) {
      await fs.writeFile(path.join(dist, file), "");
    }
  }
  return { root, stateDir, env, worker, pidFile: path.join(root, "worker.pid") };
}

function observeWorker(phase?: string) {
  const entered = createDeferred();
  const exited = createDeferred();
  const execute = commands.runUtf8CommandWithTimeout;
  let output = "";
  vi.spyOn(commands, "runUtf8CommandWithTimeout").mockImplementation((argv, options) => {
    const operation =
      typeof options === "number"
        ? execute(argv, options)
        : execute(argv, {
            ...options,
            onOutputChunk(chunk, stream) {
              options.onOutputChunk?.(chunk, stream);
              if (stream === "stderr") {
                output += chunk.toString();
                if (phase && output.includes(`"phase":"${phase}"`)) {
                  entered.resolve();
                }
              }
            },
          });
    return operation.finally(() => exited.resolve());
  });
  return { entered, exited };
}

it("coalesces snapshot progress while its receipt is settling", async () => {
  const { root, env, worker } = await fixture();
  await fs.writeFile(
    worker,
    `
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    // Buffer the burst so a full nonblocking stderr pipe cannot truncate it.
    for (let i = 0; i < 256; i++) {
      process.stderr.write("State schema progress: " + JSON.stringify({phase: "copy-" + i}) + "\\n");
    }
    process.stdout.write(JSON.stringify(request.mode === "inventory"
      ? {databases: [], pluginBytes: 0, pluginPlan: "plugin-copy-plan.json"}
      : {versions: [], pluginPaths: {}}));
  `,
  );
  const receipt = createDeferred();
  const entered = createDeferred();
  const { exited } = observeWorker();
  const observed: string[] = [];
  const operation = prepareUpdateCandidateStateSnapshot({
    candidateRoot: root,
    stateDir: env.OPENCLAW_STATE_DIR,
    config: {},
    env,
    workerEnv: () => env,
    onProgress: async (step) => {
      observed.push(step.detail ?? "");
      if (observed.length === 1) {
        entered.resolve();
        await receipt.promise;
      }
    },
  });
  try {
    await entered.promise;
    await exited.promise;
    expect(observed).toHaveLength(1);
  } finally {
    receipt.resolve();
    const snapshot = await operation;
    for (const directory of snapshot.cleanupDirectories) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  expect(observed.some((detail) => detail.includes("copy-255"))).toBe(true);
});

it.each([
  { phase: "shared database snapshot", settled: false },
  { phase: "plugin inventory", settled: false },
  { phase: "shared database snapshot", settled: true },
])(
  "retains $phase cancellation diagnostics through worker settlement (settled=$settled)",
  async ({ phase, settled }) => {
    const { root, stateDir, env, worker, pidFile } = await fixture(true);
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
    const { entered, exited } = observeWorker(phase);
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
      await awaitGateBeforeSettlement(
        entered.promise,
        operation,
        "Worker never entered the stalled phase",
      );
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
