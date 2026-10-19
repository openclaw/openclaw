import { vi } from "vitest";
import { captureSessionTarget } from "./session-controller.lifecycle.js";
import * as sessionLifecycle from "./session-controller.lifecycle.js";
import {
  registerRpcSource,
  type RpcSourceIdentity,
  type RpcSourceRef,
} from "./session-controller.rpc-sources.js";
import {
  rpcSourceRemovalByRef,
  rpcSourcesByRunId,
  sessionControllerEntriesByAlias,
  sessionControllerEntriesByStore,
  sessionControllers,
} from "./session-controller.storage.js";

export function observeSessionWorkAdmissionDrain(
  afterDrain: (
    params: Parameters<typeof sessionLifecycle.startSessionControllerInterruption>[0],
    released: boolean,
  ) => Promise<void> | void,
): () => void {
  const startInterruption = sessionLifecycle.startSessionControllerInterruption;
  const waitForRelease = sessionLifecycle.waitForSessionControllerSettlement;
  const interruptions = new WeakMap<Promise<void>, Parameters<typeof startInterruption>[0]>();
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

type RunExclusiveSessionLifecycleParams<T> = {
  scope: string;
  identities: Iterable<string | undefined>;
  signal?: AbortSignal;
  run: () => Promise<T>;
};

/** Holds real effect validation for boundary race fixtures; no production test API. */
export async function runExclusiveSessionLifecycle<T>(
  params: RunExclusiveSessionLifecycleParams<T>,
): Promise<T> {
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
  source: RpcSourceRef,
  identity: Partial<RpcSourceIdentity>,
): void {
  const current = source.input.target;
  if (!current) {
    throw new Error("Test RPC source has no captured target");
  }
  const operation = source.input.claim?.operation;
  if (operation && (identity.sessionKey !== undefined || identity.agentId !== undefined)) {
    operation.updateSessionKey(
      identity.sessionKey ?? operation.key,
      identity.agentId ?? operation.agentId,
      source.input.claim,
    );
  }
  source.input.target = captureSessionTarget({
    storeScope: current.storeScope,
    sessionKey: identity.sessionKey ?? current.sessionKey,
    incarnation: identity.sessionId ?? source.input.sourceSessionId ?? current.incarnation,
    agentId: identity.agentId ?? current.agentId,
  });
  if (identity.sessionId !== undefined) {
    source.input.sourceSessionId = identity.sessionId;
    operation?.updateSessionId(identity.sessionId);
  }
}

/** Updates an unclaimed fixture's terminal presentation. */
export function setRpcSourceTerminalProjectionForTest(
  source: RpcSourceRef,
  terminal: boolean,
): void {
  source.adapter.projectSessionTerminalPending = terminal;
  source.adapter.projectSessionTerminalPersisted = false;
}

/** Drops test-owned controller singletons after their operations have been completed. */
export function resetSessionControllerStateForTest(): void {
  rpcSourcesByRunId.clear();
  sessionControllers.clear();
  sessionControllerEntriesByAlias.clear();
  sessionControllerEntriesByStore.clear();
}

// Bind the fixture's protocol ID before using the controller's registration owner.
function registerFixtureRpcSource(runId: string, source: RpcSourceRef): void {
  if (source.input.protocolRunId !== undefined && source.input.protocolRunId !== runId) {
    throw new Error("Fixture RPC source protocol ID does not match its index key");
  }
  source.input.protocolRunId = runId;
  registerRpcSource(runId, source);
}

class RpcSourceTestMap extends Map<string, RpcSourceRef> {
  override get size(): number {
    return rpcSourcesByRunId.size;
  }

  override clear(): void {
    rpcSourcesByRunId.clear();
  }

  override delete(runId: string): boolean {
    return rpcSourcesByRunId.delete(runId);
  }

  override entries(): MapIterator<[string, RpcSourceRef]> {
    return new Map(this.uniqueEntries()).entries();
  }

  override forEach(
    callbackfn: (value: RpcSourceRef, key: string, map: Map<string, RpcSourceRef>) => void,
    thisArg?: unknown,
  ): void {
    for (const [runId, source] of this) {
      callbackfn.call(thisArg, source, runId, this);
    }
  }

  override get(runId: string): RpcSourceRef | undefined {
    const sources = rpcSourcesByRunId.get(runId);
    return sources?.size === 1 ? sources.values().next().value : undefined;
  }

  override has(runId: string): boolean {
    return (rpcSourcesByRunId.get(runId)?.size ?? 0) > 0;
  }

  override keys(): MapIterator<string> {
    return new Map(this.uniqueEntries()).keys();
  }

  override set(runId: string, source: RpcSourceRef): this {
    if (rpcSourcesByRunId.get(runId)?.has(source)) {
      return this;
    }
    rpcSourcesByRunId.delete(runId);
    registerFixtureRpcSource(runId, source);
    return this;
  }

  override values(): MapIterator<RpcSourceRef> {
    return new Map(this.uniqueEntries()).values();
  }

  override [Symbol.iterator](): MapIterator<[string, RpcSourceRef]> {
    return this.entries();
  }

  /** Legacy test fixtures only observe unambiguous protocol IDs. */
  private uniqueEntries(): Array<[string, RpcSourceRef]> {
    return [...rpcSourcesByRunId].flatMap(([runId, sources]) => {
      const source = sources.size === 1 ? sources.values().next().value : undefined;
      return source ? [[runId, source]] : [];
    });
  }
}

/** Test-only Map-shaped access to controller-owned protocol correlation. */
export const rpcSourceTesting = Object.assign(new RpcSourceTestMap(), {
  deleteExpected(runId: string, expected: RpcSourceRef): boolean {
    const sources = rpcSourcesByRunId.get(runId);
    if (!sources?.delete(expected)) {
      return false;
    }
    if (sources.size === 0) {
      rpcSourcesByRunId.delete(runId);
    }
    const onRemoved = rpcSourceRemovalByRef.get(expected);
    rpcSourceRemovalByRef.delete(expected);
    onRemoved?.();
    return true;
  },
  reset(entries: Iterable<readonly [string, RpcSourceRef]> = []): void {
    rpcSourcesByRunId.clear();
    for (const [runId, ref] of entries) {
      registerFixtureRpcSource(runId, ref);
    }
  },
});
