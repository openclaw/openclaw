import { AsyncLocalStorage } from "node:async_hooks";
import { MessageChannel } from "node:worker_threads";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import {
  POSTGRES_CONNECT_TIMEOUT_MS,
  POSTGRES_LOCK_TIMEOUT_MS,
  POSTGRES_STATEMENT_TIMEOUT_MS,
} from "../database-engine/policy.js";
import { hasIdlePostgresBridge } from "./idle-bridges.js";
import { recordPostgresPoolFailure } from "./pool-state.js";
import { selectPostgresPoolService, type PostgresPoolSetup } from "./pool.js";
import type { PostgresBridge } from "./protocol.js";

type PostgresBridgeParameters = {
  url: string;
  schema: string;
  storeId: string;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  reuse?: boolean;
};

export function postgresBridgeReuseKey(params: PostgresBridgeParameters): string {
  return sha256Hex(
    JSON.stringify([
      params.url,
      params.schema,
      params.storeId,
      params.lockTimeoutMs ?? POSTGRES_LOCK_TIMEOUT_MS,
      params.statementTimeoutMs ?? POSTGRES_STATEMENT_TIMEOUT_MS,
    ]),
  );
}

export function createPostgresBridge(params: PostgresBridgeParameters): PostgresBridge {
  const { port1, port2 } = new MessageChannel();
  const connectionSignal = new SharedArrayBuffer(8);
  const control = new Int32Array(connectionSignal);
  const { port, signal, nextStep } = selectPostgresPoolService();
  const service = new Int32Array(signal);
  if (Atomics.load(service, 1)) {
    port1.close();
    port2.close();
    const error = new Error(
      `PostgreSQL I/O service is unavailable.${nextStep ? ` Run ${nextStep}.` : ""}`,
    );
    recordPostgresPoolFailure(error);
    throw error;
  }
  try {
    port.postMessage(
      {
        connection: {
          port: port2,
          signal: connectionSignal,
          url: params.url,
          schema: params.schema,
          connectTimeoutMs: POSTGRES_CONNECT_TIMEOUT_MS,
          lockTimeoutMs: params.lockTimeoutMs ?? POSTGRES_LOCK_TIMEOUT_MS,
          statementTimeoutMs: params.statementTimeoutMs ?? POSTGRES_STATEMENT_TIMEOUT_MS,
        },
      } satisfies PostgresPoolSetup,
      [port2],
    );
  } catch (error) {
    port1.close();
    port2.close();
    throw error;
  }
  port1.unref();
  return { port: port1, control, service, nextStep, requestId: 0 };
}

type PreparedBridgeScope = {
  key: string;
  bridge?: PostgresBridge;
  detachAbort: () => void;
  parent?: PreparedBridgeScope;
};

const preparedBridgeScope = new AsyncLocalStorage<PreparedBridgeScope>();

function findPreparedBridge(key: string): PreparedBridgeScope | undefined {
  let scope = preparedBridgeScope.getStore();
  while (scope) {
    if (scope.key === key && scope.bridge && !Atomics.load(scope.bridge.service, 1)) {
      return scope;
    }
    scope = scope.parent;
  }
  return undefined;
}

export function takePreparedPostgresBridge(key: string): PostgresBridge | undefined {
  const scope = findPreparedBridge(key);
  const bridge = scope?.bridge;
  if (scope && bridge) {
    scope.bridge = undefined;
    scope.detachAbort();
  }
  return bridge;
}

/** Load the bridge during its owner's imports; connecting remains the constructor's job. */
export function preparePostgresBridge(params: PostgresBridgeParameters, signal?: AbortSignal) {
  const key = postgresBridgeReuseKey(params);
  const inherited = findPreparedBridge(key);
  const scope: PreparedBridgeScope = {
    key,
    detachAbort: () => signal?.removeEventListener("abort", abort),
    parent: preparedBridgeScope.getStore(),
  };
  const dispose = async () => {
    scope.detachAbort();
    const bridge = scope.bridge;
    scope.bridge = undefined;
    if (bridge) {
      bridge.port.close();
    }
  };
  const abort = () => {
    // The awaited disposer still reports retirement failures to the scope owner.
    void dispose().catch(() => {});
  };
  if (!signal?.aborted && !inherited && !(params.reuse && hasIdlePostgresBridge(key))) {
    scope.bridge = createPostgresBridge(params);
    signal?.addEventListener("abort", abort, { once: true });
  }
  return {
    run<T>(operation: () => T): T {
      return scope.bridge || scope.parent ? preparedBridgeScope.run(scope, operation) : operation();
    },
    [Symbol.asyncDispose]: dispose,
  };
}
