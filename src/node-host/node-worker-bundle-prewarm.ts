import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveRuntimeDeployEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeArgs, resolveRuntimeWorkerEnv } from "../infra/runtime-worker-url.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
const execFileAsync = promisify(execFile);
const log = createSubsystemLogger("node/worker-bundle");
const WORKER_PREWARM_TIMEOUT_MS = 10 * 60_000;

/** Snapshot producers and consumers warm the same code and existing compile-cache owner. */
export async function prewarmNodeWorkerBundle(params: {
  directory: string;
  bundleHash: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<void> {
  const entry = resolveRuntimeDeployEntrypointUrl("worker", params.directory);
  const prewarmStarted = performance.now();
  let outcome = "failed";
  try {
    await execFileAsync(
      process.execPath,
      [...resolveRuntimeArgs(), fileURLToPath(entry), "--internal-worker-prewarm"],
      {
        cwd: params.directory,
        env: resolveRuntimeWorkerEnv(entry, params.env),
        timeout: WORKER_PREWARM_TIMEOUT_MS,
        windowsHide: true,
        ...(params.signal ? { signal: params.signal } : {}),
      },
    );
    outcome = "success";
  } catch (error) {
    if (params.signal?.aborted) {
      throw params.signal.reason ?? error;
    }
    throw error;
  } finally {
    const fields = {
      bundleHash: params.bundleHash,
      phase: "runtime.prewarm",
      outcome,
      durationMs: Math.round(performance.now() - prewarmStarted),
    };
    try {
      log.info("Worker bundle prewarm", {
        ...fields,
        consoleMessage: `Worker bundle prewarm ${JSON.stringify(fields)}`,
      });
    } catch {
      /* Diagnostics cannot change the child execution result. */
    }
  }
}
