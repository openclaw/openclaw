import os from "node:os";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { gatewaySpawnBrokerState } from "./context-state.js";
import type { SpawnBrokerHost } from "./host.js";

export { getSpawnBroker, runWithSpawnBroker } from "./context-state.js";

/** A failed startup optimization stays disabled across Gateway restarts in this process. */
export async function startGatewaySpawnBroker(options: {
  onReady: (pid: number, restarted: boolean) => void;
  onStartupFailure: (message: string) => void | Promise<void>;
}): Promise<SpawnBrokerHost | undefined> {
  if (gatewaySpawnBrokerState.startupDisabled) {
    return undefined;
  }
  const constrained = process.constrainedMemory();
  const memory = constrained > 0 ? Math.min(os.totalmem(), constrained) : os.totalmem();
  // On small hosts, keep the broker's resident memory available to requests.
  // Direct spawning retains the existing lifecycle at the cost of Linux fork latency.
  if (memory <= 1024 ** 3) {
    return undefined;
  }
  let broker: SpawnBrokerHost | undefined;
  let entryPath: string = runtimeProcessEntrypoints.spawnBroker.distWorkerPath;
  try {
    const { createSpawnBrokerHost } = await import("./host.js");
    broker = createSpawnBrokerHost({
      onReady: options.onReady,
      onClosed: () => {
        if (gatewaySpawnBrokerState.host === broker) {
          gatewaySpawnBrokerState.host = undefined;
        }
      },
    });
    entryPath = broker.entryPath;
    await broker.ready();
    gatewaySpawnBrokerState.host = broker;
    return broker;
  } catch (error) {
    gatewaySpawnBrokerState.startupDisabled = true;
    let reason = toErrorObject(error, "Spawn broker startup failed").message;
    try {
      await broker?.close();
    } catch (cleanupError) {
      reason += `; cleanup failed: ${toErrorObject(cleanupError, "Spawn broker cleanup failed").message}`;
    }
    await options.onStartupFailure(
      `spawn broker startup failed: ${reason}; runtime entry=${entryPath}; in-process spawning is in effect for the lifetime of this process`
        .replaceAll("\r", " ")
        .replaceAll("\n", " "),
    );
    return undefined;
  }
}
