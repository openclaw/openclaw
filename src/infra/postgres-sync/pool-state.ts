import { workerData, type MessagePort, type Worker } from "node:worker_threads";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

export type PostgresPoolEndpoint = { port: MessagePort; signal: SharedArrayBuffer };
export type PostgresPoolEndpoints = {
  services: PostgresPoolEndpoint[];
  allocation: SharedArrayBuffer;
  nextStep?: string;
};

type PoolState = {
  endpoints?: PostgresPoolEndpoints;
  workers?: Worker[];
  nextStep?: string;
  ready: Promise<void>[];
  refresh?: () => void;
  failure?: Error;
};

const inherited: { postgresPool?: PostgresPoolEndpoints } | null = workerData;
export const postgresPoolState = resolveGlobalSingleton<PoolState>(
  Symbol.for("openclaw.postgresIoPool"),
  () => ({
    endpoints: inherited?.postgresPool,
    workers: undefined,
    nextStep: undefined,
    ready: [],
    refresh: undefined,
    failure: undefined,
  }),
);

/** A failed service invalidates this SQL host; its existing task owner retires it. */
export function recordPostgresPoolFailure(error: Error): void {
  if (!postgresPoolState.nextStep && !postgresPoolState.endpoints?.nextStep) {
    postgresPoolState.failure ??= error;
  }
}

export function postgresPoolWorkerFailure(): Error | undefined {
  return postgresPoolState.failure;
}

export function bindPostgresPool(endpoints: PostgresPoolEndpoints): void {
  if (postgresPoolState.endpoints) {
    // Reused carriers keep their original hosts and the connections owned by them.
    if (postgresPoolState.endpoints === endpoints) {
      return;
    }
    for (const { port } of endpoints.services) {
      port.close();
    }
    return;
  }
  postgresPoolState.endpoints = endpoints;
}
