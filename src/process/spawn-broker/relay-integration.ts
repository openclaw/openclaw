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
  let transportReady: Promise<void> | undefined;
  if (child instanceof BrokerChild) {
    transportReady = child.ready().catch((error: unknown) => {
      cleanup.completion.reject(error);
      throw error;
    });
  } else if (child.pid === undefined) {
    // Native spawn failures can lack stdio entirely. Join Node's close before
    // releasing the no-process cleanup owner, and preserve its original errno.
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    transportReady = new Promise<Error>((resolve) => {
      child.once("error", resolve);
    }).then(async (error) => {
      await closed;
      cleanup.completion.resolve();
      throw error;
    });
  }
  return { child, cleanup, transportReady };
}
