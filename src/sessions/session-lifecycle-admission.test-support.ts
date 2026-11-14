import { vi } from "vitest";
import * as sessionLifecycle from "./session-controller.lifecycle.js";
import * as rpc from "./session-controller.rpc-sources.js";
import * as storage from "./session-controller.storage.js";

type InterruptionParams = Parameters<typeof sessionLifecycle.startSessionControllerInterruption>[0];
export function observeSessionWorkAdmissionDrain(
  afterDrain: (params: InterruptionParams, released: boolean) => Promise<void> | void,
): () => void {
  const startInterruption = sessionLifecycle.startSessionControllerInterruption;
  const waitForRelease = sessionLifecycle.waitForSessionControllerSettlement;
  const interruptions = new WeakMap<Promise<void>, InterruptionParams>();
  const start = vi
    .spyOn(sessionLifecycle, "startSessionControllerInterruption")
    .mockImplementation((params) => {
      const interruption = startInterruption(params);
      interruptions.set(interruption.released, params);
      return interruption;
    });
  const wait = vi
    .spyOn(sessionLifecycle, "waitForSessionControllerSettlement")
    .mockImplementation(async (pending, timeoutMs) => {
      const released = await waitForRelease(pending, timeoutMs);
      const params = interruptions.get(pending);
      if (params) {
        interruptions.delete(pending);
        // Fixture pauses follow the real drain, outside its production deadline.
        await afterDrain(params, released);
      }
      return released;
    });
  return () => {
    wait.mockRestore();
    start.mockRestore();
  };
}

/** Holds real effect validation for boundary race fixtures; no production test API. */
export async function runExclusiveSessionLifecycle<T>(params: {
  scope: string;
  identities: Iterable<string | undefined>;
  signal?: AbortSignal;
  run: () => Promise<T>;
}): Promise<T> {
  let result: { value: T } | undefined;
  const effect = await sessionLifecycle.beginSessionEffect({
    scope: params.scope,
    identities: params.identities,
    signal: params.signal,
    assertAllowed: async () => {
      result = { value: await params.run() };
    },
    revalidateAllowed: () => {},
  });
  effect.release();
  if (!result) {
    throw new Error("Effect validator did not execute");
  }
  return result.value;
}

/** Rebinds a fixture through controller-owned target and operation identity. */
export function setRpcSourceIdentityForTest(
  source: rpc.RpcSourceRef,
  { sessionKey, agentId, sessionId }: Partial<rpc.RpcSourceIdentity>,
): void {
  const current = source.input.target;
  if (!current) {
    throw new Error("Test RPC source has no captured target");
  }
  const operation = source.input.claim?.operation;
  if (operation && (sessionKey !== undefined || agentId !== undefined)) {
    operation.updateSessionKey(
      sessionKey ?? operation.key,
      agentId ?? operation.agentId,
      source.input.claim,
    );
  }
  source.input.target = sessionLifecycle.captureSessionTarget({
    storeScope: current.storeScope,
    sessionKey: sessionKey ?? current.sessionKey,
    incarnation: sessionId ?? source.input.sourceSessionId ?? current.incarnation,
    agentId: agentId ?? current.agentId,
  });
  if (sessionId !== undefined) {
    source.input.sourceSessionId = sessionId;
    operation?.updateSessionId(sessionId);
  }
}

export function setRpcSourceTerminalProjectionForTest(
  source: rpc.RpcSourceRef,
  terminal: boolean,
): void {
  source.adapter.projectSessionTerminalPending = terminal;
  source.adapter.projectSessionTerminalPersisted = false;
}

/** Drops test-owned controller singletons after their operations have been completed. */
export function resetSessionControllerStateForTest(): void {
  storage.rpcSourcesByRunId.clear();
  storage.sessionControllers.clear();
  storage.sessionControllerEntriesByAlias.clear();
  storage.sessionControllerEntriesByStore.clear();
}

// Bind the fixture's protocol ID before using the controller's registration owner.
function registerFixtureRpcSource(runId: string, source: rpc.RpcSourceRef): void {
  if (source.input.protocolRunId !== undefined && source.input.protocolRunId !== runId) {
    throw new Error("Fixture RPC source protocol ID does not match its index key");
  }
  source.input.protocolRunId = runId;
  rpc.registerRpcSource(runId, source);
}

function uniqueRpcSource(runId: string): rpc.RpcSourceRef | undefined {
  const sources = storage.rpcSourcesByRunId.get(runId);
  return sources?.size === 1 ? sources.values().next().value : undefined;
}

function rpcSnapshot(): Map<string, rpc.RpcSourceRef> {
  return new Map(
    [...storage.rpcSourcesByRunId.keys()].flatMap((runId) => {
      const source = uniqueRpcSource(runId);
      return source ? [[runId, source] as const] : [];
    }),
  );
}

// The production registry owns correlation; fixtures expose only unambiguous IDs.
export const rpcSourceTesting = {
  get size() {
    return storage.rpcSourcesByRunId.size;
  },
  clear: () => storage.rpcSourcesByRunId.clear(),
  delete: (runId: string) => storage.rpcSourcesByRunId.delete(runId),
  get: uniqueRpcSource,
  has: (runId: string) => (storage.rpcSourcesByRunId.get(runId)?.size ?? 0) > 0,
  entries: () => rpcSnapshot().entries(),
  values: () => rpcSnapshot().values(),
  [Symbol.iterator]() {
    return this.entries();
  },
  set(runId: string, source: rpc.RpcSourceRef) {
    if (!storage.rpcSourcesByRunId.get(runId)?.has(source)) {
      storage.rpcSourcesByRunId.delete(runId);
      registerFixtureRpcSource(runId, source);
    }
    return this;
  },
  deleteExpected(runId: string, expected: rpc.RpcSourceRef): boolean {
    const sources = storage.rpcSourcesByRunId.get(runId);
    if (!sources?.delete(expected)) {
      return false;
    }
    if (sources.size === 0) {
      storage.rpcSourcesByRunId.delete(runId);
    }
    const onRemoved = storage.rpcSourceRemovalByRef.get(expected);
    storage.rpcSourceRemovalByRef.delete(expected);
    onRemoved?.();
    return true;
  },
  reset(entries: Iterable<readonly [string, rpc.RpcSourceRef]> = []): void {
    storage.rpcSourcesByRunId.clear();
    for (const [runId, ref] of entries) {
      registerFixtureRpcSource(runId, ref);
    }
  },
};
