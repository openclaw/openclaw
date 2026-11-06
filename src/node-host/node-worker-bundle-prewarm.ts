import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveRuntimeDeployEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeArgs, resolveRuntimeWorkerEnv } from "../infra/runtime-worker-url.js";

const execFileAsync = promisify(execFile);

/** Producers and consumers use the same entrypoint and existing compile-cache environment. */
export async function prewarmNodeWorkerBundle(params: {
  directory: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<void> {
  const entry = resolveRuntimeDeployEntrypointUrl("worker", params.directory);
  try {
    await execFileAsync(
      process.execPath,
      [...resolveRuntimeArgs(), fileURLToPath(entry), "--internal-worker-prewarm"],
      {
        cwd: params.directory,
        env: resolveRuntimeWorkerEnv(entry, params.env),
        timeout: 10 * 60_000,
        windowsHide: true,
        ...(params.signal ? { signal: params.signal } : {}),
      },
    );
  } catch (error) {
    if (params.signal?.aborted) {
      throw params.signal.reason ?? error;
    }
    throw error;
  }
}
