import type { ChildProcess, SpawnOptions } from "node:child_process";
import { resolveRuntimeWorkerArgv } from "../../infra/runtime-worker-url.js";
import { spawnProcess } from "../spawn-utils.js";
import { createServiceChildCleanup } from "../supervisor/service-child-cleanup.js";
import { BrokerChild } from "./child.js";

/** Publish cleanup ownership before waiting for the broker's pipe and IPC handoff. */
export function spawnServiceChildRelay(params: {
  workerUrl: URL;
  stdio: SpawnOptions["stdio"];
  env: NodeJS.ProcessEnv;
  detached: boolean;
  onSpawnCleanup?: (completion: Promise<void>) => void;
}): {
  child: ChildProcess;
  cleanup: ReturnType<typeof createServiceChildCleanup>;
  transportReady: Promise<void> | undefined;
} {
  const child = spawnProcess(process.execPath, resolveRuntimeWorkerArgv(params.workerUrl), {
    stdio: params.stdio,
    detached: params.detached,
    windowsHide: true,
    env: params.env,
  });
  const cleanup = createServiceChildCleanup();
  params.onSpawnCleanup?.(cleanup.promise);
  // Native pipes are ready synchronously; only the broker waits for transferred handles.
  const transportReady =
    child instanceof BrokerChild
      ? child.ready().catch((error: unknown) => {
          cleanup.completion.reject(error);
          throw error;
        })
      : undefined;
  return { child, cleanup, transportReady };
}
