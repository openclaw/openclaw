import { AsyncLocalStorage } from "node:async_hooks";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import type { SpawnBrokerHost } from "./host.js";

const context = new AsyncLocalStorage<SpawnBrokerHost | undefined>();
let gatewayStartupDisabled = false;

/** A failed startup optimization stays disabled across Gateway restarts in this process. */
export async function startGatewaySpawnBroker(options: {
  onReady: (pid: number, restarted: boolean) => void;
  onStartupFailure: (message: string) => void | Promise<void>;
}): Promise<SpawnBrokerHost | undefined> {
  if (gatewayStartupDisabled) {
    return undefined;
  }
  let broker: SpawnBrokerHost | undefined;
  let entryPath: string = runtimeProcessEntrypoints.spawnBroker.distWorkerPath;
  try {
    const { createSpawnBrokerHost, spawnBrokerEntryPath } = await import("./host.js");
    entryPath = spawnBrokerEntryPath;
    broker = createSpawnBrokerHost({ onReady: options.onReady });
    await broker.ready();
    return broker;
  } catch (error) {
    gatewayStartupDisabled = true;
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

export function runWithSpawnBroker<T>(host: SpawnBrokerHost | undefined, run: () => T): T {
  return context.run(host, run);
}

export function getSpawnBroker(): SpawnBrokerHost | undefined {
  return gatewayStartupDisabled ? undefined : context.getStore();
}
