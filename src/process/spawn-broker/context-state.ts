import { AsyncContext } from "../../shared/async-context.js";
import type { SpawnBrokerHost } from "./host-contract.js";

const context = new AsyncContext<SpawnBrokerHost | null>(Symbol("spawnBroker"));

/** Shared with startup without importing its host factory into low-level workers. */
export const gatewaySpawnBrokerState: {
  host?: SpawnBrokerHost;
  startupDisabled: boolean;
} = { startupDisabled: false };

export function runWithSpawnBroker<T>(host: SpawnBrokerHost | undefined, run: () => T): T {
  // Explicit native-only scopes must override the Gateway transport, too.
  return context.run(host ?? null, run);
}

export function getSpawnBroker(): SpawnBrokerHost | undefined {
  const scoped = context.getStore();
  // Detached work drops request authority, not the process-owned spawn transport.
  return gatewaySpawnBrokerState.startupDisabled || scoped === null
    ? undefined
    : (scoped ?? gatewaySpawnBrokerState.host);
}
