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

function* inventoryBatches(files: readonly string[]): Generator<string[]> {
  let batch: string[] = [];
  let bytes = 0;
  for (const file of files) {
    // Include JSON escaping and UTF-8, plus room for the result's keys and bigint size.
    const entryBytes = Buffer.byteLength(JSON.stringify(file), "utf8") + 64;
    if (batch.length && bytes + entryBytes > 512 * 1024) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += entryBytes;
  }
  if (batch.length) {
    yield batch;
  }
}

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
  const deadline =
    Date.now() + resolveTimerTimeoutMs(Math.max(options.timeoutMs ?? 0, budget), budget);
  const entries: Array<{ path: string; sizeBytes: bigint | undefined }> = [];
  let dispose: (() => void) | undefined;
  let cleanupUncertain = false;
  let termination: string | undefined;
  try {
    options.signal?.throwIfAborted();
    // Embedded source remains available after activation replaces the updater package.
    const script = prepareRuntimeProcessScriptInvocation("updateStateSizes", options.nodeRunner, {
      parentDirectory: options.stagingRoot,
    });
    dispose = () => script.dispose();
    for (const batch of inventoryBatches(files)) {
      options.signal?.throwIfAborted();
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        termination = "timeout";
        throw new Error("Aggregate metadata inventory deadline exceeded");
      }
      const result = await withUpdateStateInspectionWork(
        () =>
          runUtf8CommandWithTimeout(script.argv, {
            cwd: os.tmpdir(),
            input: JSON.stringify({ files: batch }),
            baseEnv: options.sourceEnv,
            env: { XDG_CACHE_HOME: options.stagingRoot },
            signal: options.signal,
            timeoutMs: remainingMs,
            killGraceMs: 500,
            killProcessTree: true,
            maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
            outputCapture: { stdout: "head", stderr: "discard" },
            terminateOnOutputLimit: { stdout: true },
            onOutputChunk: inspection.onOutputChunk,
          }),
        options.signal,
      );
      options.signal?.throwIfAborted();
      if (result.code !== 0 || result.termination !== "exit" || result.outputLimitExceeded) {
        termination = result.outputLimitExceeded ? "output-limit" : result.termination;
        throw new Error(inspection.stderr());
      }
      for (const entry of inventorySchema.parse(JSON.parse(result.stdout))) {
        entries.push({
          path: entry.path,
          sizeBytes: entry.sizeBytes === undefined ? undefined : BigInt(entry.sizeBytes),
        });
      }
    }
    options.signal?.throwIfAborted();
    return entries;
  } catch (error) {
    cleanupUncertain = hasCommandProcessCleanupError(error);
    if (!cleanupUncertain) {
      options.signal?.throwIfAborted();
    }
    throw inspection.failure(error, termination);
  } finally {
    if (!cleanupUncertain) {
      dispose?.();
    }
  }
}
