import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { AsyncContext } from "../../shared/async-context.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";

const context = new AsyncContext<SpawnBrokerHost | null>(Symbol("spawnBroker"));
let gatewayBroker: SpawnBrokerHost | undefined;
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
    broker = createSpawnBrokerHost({
      onReady: options.onReady,
      onClosed: () => {
        if (gatewayBroker === broker) {
          gatewayBroker = undefined;
        }
      },
    });
    entryPath = broker.entryPath;
    await broker.ready();
    gatewayBroker = broker;
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
  // Explicit native-only scopes must override the Gateway transport, too.
  return context.run(host ?? null, run);
}

export function getSpawnBroker(): SpawnBrokerHost | undefined {
  const scoped = context.getStore();
  // Detached work drops request authority, not the process-owned spawn transport.
  return gatewayStartupDisabled || scoped === null ? undefined : (scoped ?? gatewayBroker);
}
