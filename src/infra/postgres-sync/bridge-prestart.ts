import { AsyncLocalStorage } from "node:async_hooks";
import { MessageChannel, Worker } from "node:worker_threads";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import {
  POSTGRES_CONNECT_TIMEOUT_MS,
  POSTGRES_LOCK_TIMEOUT_MS,
  POSTGRES_STATEMENT_TIMEOUT_MS,
} from "../database-engine/policy.js";
import { resolveRuntimeProcessEntrypointUrl } from "../runtime-process-url.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../runtime-worker-url.js";
import { trackNativeWorkerForCpu } from "../worker-cpu.js";
import { hasIdlePostgresBridge } from "./idle-bridges.js";
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
  const control = new Int32Array(new SharedArrayBuffer(8));
  const workerUrl = resolveRuntimeProcessEntrypointUrl("postgresBridge");
  let worker: Worker;
  try {
    worker = new Worker(workerUrl, {
      workerData: {
        port: port2,
        signal: control.buffer,
        url: params.url,
        schema: params.schema,
        connectTimeoutMs: POSTGRES_CONNECT_TIMEOUT_MS,
        lockTimeoutMs: params.lockTimeoutMs ?? POSTGRES_LOCK_TIMEOUT_MS,
        statementTimeoutMs: params.statementTimeoutMs ?? POSTGRES_STATEMENT_TIMEOUT_MS,
      },
      transferList: [port2],
      execArgv: resolveRuntimeWorkerThreadExecArgv(workerUrl),
    });
  } catch (error) {
    port1.close();
    port2.close();
    throw error;
  }
  trackNativeWorkerForCpu(worker, workerUrl);
  worker.unref();
  port1.unref();
  return { port: port1, control, worker, requestId: 0 };
}

type PreparedBridgeScope = {
  key: string;
  bridge?: PostgresBridge;
  unavailable: boolean;
  onError: () => void;
  onExit: () => void;
  detachAbort: () => void;
  parent?: PreparedBridgeScope;
};

const preparedBridgeScope = new AsyncLocalStorage<PreparedBridgeScope>();

function findPreparedBridge(key: string): PreparedBridgeScope | undefined {
  let scope = preparedBridgeScope.getStore();
  while (scope) {
    if (scope.key === key && scope.bridge && !scope.unavailable) {
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
    bridge.worker.off("error", scope.onError);
    bridge.worker.off("exit", scope.onExit);
  }
  return bridge;
}

/** Load the bridge during its owner's imports; connecting remains the constructor's job. */
export function preparePostgresBridge(params: PostgresBridgeParameters, signal?: AbortSignal) {
  const key = postgresBridgeReuseKey(params);
  const inherited = findPreparedBridge(key);
  const scope: PreparedBridgeScope = {
    key,
    unavailable: false,
    onError: () => {
      scope.unavailable = true;
    },
    onExit: () => {
      scope.unavailable = true;
    },
    detachAbort: () => signal?.removeEventListener("abort", abort),
    parent: preparedBridgeScope.getStore(),
  };
  let termination: Promise<unknown> | undefined;
  const dispose = async () => {
    scope.detachAbort();
    const bridge = scope.bridge;
    scope.bridge = undefined;
    if (bridge) {
      bridge.port.close();
      termination = bridge.worker.terminate().finally(() => {
        bridge.worker.off("error", scope.onError);
        bridge.worker.off("exit", scope.onExit);
      });
    }
    await termination;
  };
  const abort = () => {
    // The awaited disposer still reports retirement failures to the scope owner.
    void dispose().catch(() => {});
  };
  if (!signal?.aborted && !inherited && !(params.reuse && hasIdlePostgresBridge(key))) {
    scope.bridge = createPostgresBridge(params);
    scope.bridge.worker.on("error", scope.onError);
    scope.bridge.worker.on("exit", scope.onExit);
    signal?.addEventListener("abort", abort, { once: true });
  }
  return {
    run<T>(operation: () => T): T {
      return scope.bridge || scope.parent ? preparedBridgeScope.run(scope, operation) : operation();
    },
    [Symbol.asyncDispose]: dispose,
  };
}
