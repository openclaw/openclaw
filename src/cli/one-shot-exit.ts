import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

type VitestWorkerMarkers = {
  tinypoolState?: unknown;
  vitestWorker?: unknown;
};

let exitRequested = false;

function resolveVitestWorkerMarkers(): VitestWorkerMarkers {
  return {
    tinypoolState: (process as NodeJS.Process & { __tinypool_state__?: unknown })
      .__tinypool_state__,
    vitestWorker: (globalThis as typeof globalThis & { __vitest_worker__?: unknown })
      .__vitest_worker__,
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

export function requestExitAfterOneShotOutput(runtime: RuntimeEnv = defaultRuntime): void {
  if (runtime === defaultRuntime) {
    exitRequested = true;
  }
}

export function flushExitAfterOneShotOutput(
  runtime: RuntimeEnv = defaultRuntime,
  env: NodeJS.ProcessEnv = process.env,
  markers: VitestWorkerMarkers = resolveVitestWorkerMarkers(),
): void {
  const shouldExit = exitRequested && runtime === defaultRuntime && !isVitestWorker(env, markers);
  exitRequested = false;
  if (!shouldExit) {
    return;
  }

  const exit = () => runtime.exit(0);
  let pendingStreams = 0;

  const maybeDrain = (stream: NodeJS.WriteStream) => {
    if (stream.writableLength <= 0) {
      return;
    }
    pendingStreams += 1;
    stream.write("", () => {
      pendingStreams -= 1;
      if (pendingStreams === 0) {
        setImmediate(exit);
      }
    });
  };

  maybeDrain(process.stdout);
  maybeDrain(process.stderr);

  if (pendingStreams > 0) {
    return;
  }
  setImmediate(exit);
}
