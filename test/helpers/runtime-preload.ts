import { pathToFileURL } from "node:url";
import type { WorkerOptions } from "node:worker_threads";

/** Descendants can select either runtime, independently of the test runner. */
export function withRuntimePreload(env: NodeJS.ProcessEnv, preloadPath: string): NodeJS.ProcessEnv {
  const preloadUrl = pathToFileURL(preloadPath).href;
  return {
    ...env,
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --import=${preloadUrl}`.trim(),
    BUN_OPTIONS: `${env.BUN_OPTIONS ?? ""} --preload=${preloadUrl}`.trim(),
  };
}

export function withWorkerPreload(
  options: WorkerOptions | undefined,
  source: string,
  workerData?: Record<string, unknown>,
): WorkerOptions {
  return {
    ...options,
    execArgv: [
      ...(options?.execArgv ?? []),
      "--import",
      `data:text/javascript,${encodeURIComponent(source)}`,
    ],
    ...(workerData === undefined ? {} : { workerData: { ...options?.workerData, ...workerData } }),
  };
}
