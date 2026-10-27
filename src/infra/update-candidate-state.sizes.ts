import fs from "node:fs/promises";
import os from "node:os";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { z } from "zod";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { ignoreMissingPath } from "./errno.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { prepareRuntimeProcessScriptInvocation } from "./runtime-process-url.js";
import { resolveAggregateSqliteInspectionTimeoutMs } from "./sqlite-readonly-worker.js";
import { createUpdateStateInspectionDiagnostics } from "./update-candidate-state.diagnostics.js";
import { withUpdateStateInspectionWork } from "./update-candidate-state.process.js";

const inventorySchema = z.array(
  z.object({ path: z.string(), sizeBytes: z.string().regex(/^\d+$/).optional() }),
);

export async function updateStateDatabaseExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    return ignoreMissingPath(error) ?? false;
  }
}

/** Maintenance custody permits metadata reads without an isolated inventory process. */
export async function readUpdateStateDatabaseSizesInProcess(
  files: readonly string[],
  signal?: AbortSignal,
): Promise<Array<{ path: string; sizeBytes: bigint | undefined }>> {
  const result: Array<{ path: string; sizeBytes: bigint | undefined }> = [];
  for (const file of files) {
    signal?.throwIfAborted();
    let sizeBytes: bigint | undefined;
    try {
      sizeBytes = (await fs.stat(file, { bigint: true })).size;
    } catch (error) {
      if (!hasNodeErrorCode(error, "ENOENT")) {
        result.push({ path: file, sizeBytes: undefined });
      }
      continue;
    }
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try {
        sizeBytes += (await fs.stat(file + suffix, { bigint: true })).size;
      } catch (error) {
        if (!hasNodeErrorCode(error, "ENOENT")) {
          sizeBytes = undefined;
          break;
        }
      }
    }
    result.push({ path: file, sizeBytes });
  }
  return result;
}

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
  let dispose: (() => void) | undefined;
  let cleanupUncertain = false;
  try {
    options.signal?.throwIfAborted();
    // Embedded source remains available after activation replaces the updater package.
    const script = prepareRuntimeProcessScriptInvocation("updateStateSizes", options.nodeRunner, {
      parentDirectory: options.stagingRoot,
    });
    dispose = () => script.dispose();
    result = await withUpdateStateInspectionWork(
      () =>
        runUtf8CommandWithTimeout(script.argv, {
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
        }),
      options.signal,
    );
  } catch (error) {
    cleanupUncertain = hasCommandProcessCleanupError(error);
    if (!cleanupUncertain) {
      options.signal?.throwIfAborted();
    }
    throw inspection.failure(error);
  } finally {
    if (!cleanupUncertain) {
      dispose?.();
    }
  }
  options.signal?.throwIfAborted();
  if (result.code !== 0 || result.termination !== "exit" || result.outputLimitExceeded) {
    throw inspection.failure(
      inspection.stderr(),
      result.outputLimitExceeded ? "output-limit" : result.termination,
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
