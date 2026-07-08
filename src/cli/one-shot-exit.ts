import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

type VitestWorkerMarkers = {
  tinypoolState?: unknown;
  vitestWorker?: unknown;
};

let requestedExitCode: number | undefined;

function resolveVitestWorkerMarkers(): VitestWorkerMarkers {
  const processMarkers = process as NodeJS.Process & Record<string, unknown>;
  const globalMarkers = globalThis as typeof globalThis & Record<string, unknown>;
  return {
    tinypoolState: processMarkers["__tinypool_state__"],
    vitestWorker: globalMarkers["__vitest_worker__"],
  };
}

function isVitestWorker(
  env: NodeJS.ProcessEnv,
  markers: VitestWorkerMarkers = resolveVitestWorkerMarkers(),
): boolean {
  const hasVitestEnv =
    env.VITEST === "true" ||
    env.VITEST === "1" ||
    env.VITEST_POOL_ID !== undefined ||
    env.VITEST_WORKER_ID !== undefined;
  return (
    hasVitestEnv && (markers.tinypoolState !== undefined || markers.vitestWorker !== undefined)
  );
}

export function requestExitAfterOneShotOutput(
  runtime: RuntimeEnv = defaultRuntime,
  exitCode = 0,
): boolean {
  if (runtime !== defaultRuntime) {
    return false;
  }
  requestedExitCode = exitCode;
  return true;
}

export function flushExitAfterOneShotOutput(
  runtime: RuntimeEnv = defaultRuntime,
  env: NodeJS.ProcessEnv = process.env,
  markers: VitestWorkerMarkers = resolveVitestWorkerMarkers(),
): void {
  const exitCode = requestedExitCode;
  requestedExitCode = undefined;
  if (exitCode === undefined || runtime !== defaultRuntime || isVitestWorker(env, markers)) {
    return;
  }

  const exit = () => runtime.exit(exitCode);
  let pendingStreams = 2;

  const drain = (stream: NodeJS.WriteStream) => {
    stream.write("", () => {
      pendingStreams -= 1;
      if (pendingStreams === 0) {
        setImmediate(exit);
      }
    });
  };

  drain(process.stdout);
  drain(process.stderr);
}
