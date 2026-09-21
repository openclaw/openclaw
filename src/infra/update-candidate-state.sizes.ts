import os from "node:os";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { z } from "zod";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { resolveAggregateSqliteInspectionTimeoutMs } from "./sqlite-readonly-worker.js";
import {
  createUpdateStateInspectionDiagnostics,
  UPDATE_STATE_INSPECTION_PROGRESS_PREFIX,
} from "./update-candidate-state.diagnostics.js";
import { withUpdateStateInspectionWork } from "./update-candidate-state.process.js";

// Retain a core-only program: activation can remove the updater package from disk.
// The child owns all source/sidecar stats, including blocked remote filesystem calls.
const inventorySource = `
  const fs = require("node:fs");
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    const result = [];
    const progress = path => fs.writeSync(2, ${JSON.stringify(UPDATE_STATE_INSPECTION_PROGRESS_PREFIX)} + JSON.stringify({ phase: "metadata inventory", path }) + "\\n");
    for (const file of JSON.parse(input).files) {
      let size;
      progress(file);
      try { size = fs.statSync(file, { bigint: true }).size; }
      catch (error) {
        if (error.code !== "ENOENT") result.push({ path: file });
        continue;
      }
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        progress(file + suffix);
        try { size += fs.statSync(file + suffix, { bigint: true }).size; }
        catch (error) {
          if (error.code !== "ENOENT") { size = undefined; break; }
        }
      }
      result.push({ path: file, sizeBytes: size?.toString() });
    }
    process.stdout.write(JSON.stringify(result));
  });
`;
const inventorySchema = z.array(
  z.object({ path: z.string(), sizeBytes: z.string().regex(/^\d+$/).optional() }),
);

/** Measure SQLite families in a bounded child so metadata cannot block updater cancellation. */
export async function readUpdateStateDatabaseSizes(
  files: readonly string[],
  options: {
    nodeRunner: string;
    sourceEnv: NodeJS.ProcessEnv;
    stagingRoot: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<Array<{ path: string; sizeBytes: bigint | undefined }>> {
  // Until sizes are known, use the existing per-source startup/shutdown budget.
  const budget = resolveAggregateSqliteInspectionTimeoutMs(
    "state schema inventory",
    files.map((file) => ({ path: file, sizeBytes: undefined })),
  );
  const inspection = createUpdateStateInspectionDiagnostics({
    operation: "State schema inventory",
    phase: "metadata inventory",
    paths: files,
  });
  let result;
  try {
    result = await withUpdateStateInspectionWork(
      () =>
        runUtf8CommandWithTimeout(
          [options.nodeRunner, "--input-type=commonjs", "--eval", inventorySource],
          {
            cwd: os.tmpdir(),
            input: JSON.stringify({ files }),
            baseEnv: options.sourceEnv,
            env: { XDG_CACHE_HOME: options.stagingRoot },
            signal: options.signal,
            timeoutMs: resolveTimerTimeoutMs(Math.max(options.timeoutMs ?? 0, budget), budget),
            killGraceMs: 500,
            killProcessTree: true,
            maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
            outputCapture: { stdout: "head", stderr: "discard" },
            terminateOnOutputLimit: { stdout: true },
            onOutputChunk: inspection.onOutputChunk,
          },
        ),
      options.signal,
    );
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw inspection.failure(error);
    }
    options.signal?.throwIfAborted();
    throw inspection.failure(error);
  }
  options.signal?.throwIfAborted();
  if (result.code !== 0 || result.termination !== "exit" || result.outputLimitExceeded) {
    throw inspection.failure(
      inspection.stderr() ||
        (result.outputLimitExceeded ? "Worker output exceeded its capture limit" : ""),
      result.termination,
    );
  }
  try {
    return inventorySchema.parse(JSON.parse(result.stdout)).map((entry) => ({
      path: entry.path,
      sizeBytes: entry.sizeBytes === undefined ? undefined : BigInt(entry.sizeBytes),
    }));
  } catch (error) {
    throw inspection.failure(error);
  }
}
