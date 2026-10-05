import { randomUUID } from "node:crypto";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  isIncognitoComputeCommand,
  isIncognitoStoreComputeCommand,
  type IncognitoComputeOperations,
  type IncognitoComputeTarget,
} from "./session-incognito-compute-contract.js";
import type { IncognitoSessionFacts } from "./session-incognito-facts.types.js";

export type IncognitoComputeScope = {
  assertCurrent(this: void): void;
  execute<Key extends keyof IncognitoComputeOperations>(command: {
    type: Key;
    input: IncognitoComputeOperations[Key]["input"];
  }): Promise<IncognitoComputeOperations[Key]["output"]>;
};

/** Cleanup owns only resources captured before dispatch; it never grants data access. */
export function withIncognitoCompute<T, Claim extends { assertCurrent(this: void): void }>(params: {
  target?: IncognitoComputeTarget;
  assertAuthority(this: void): void;
  assertBorrowed(this: void): void;
  captureClaim(sessionKey: string, facts?: IncognitoSessionFacts): Claim;
  authorize(this: void, claim: Claim): void;
  execute<Key extends keyof IncognitoComputeOperations>(
    command: { type: Key; input: IncognitoComputeOperations[Key]["input"] },
    observeFacts: (facts: readonly IncognitoSessionFacts[]) => void,
  ): Promise<IncognitoComputeOperations[Key]["output"]>;
  cleanup: IncognitoComputeScope["execute"];
  operation(scope: IncognitoComputeScope): Promise<T>;
}): Promise<T> {
  const target = structuredClone(params.target);
  const selected = new Map<string, Claim>();
  if (target) {
    selected.set(target.sessionKey, params.captureClaim(target.sessionKey));
  }
  const observeFacts = (facts: readonly IncognitoSessionFacts[]) => {
    if (!target) {
      for (const fact of facts) {
        if (!selected.has(fact.sessionKey)) {
          selected.set(fact.sessionKey, params.captureClaim(fact.sessionKey, fact));
        }
      }
    }
  };
  const disclose = () => selected.forEach(params.authorize);
  const sources = new Map<string, { sourceId: string; target: IncognitoComputeTarget }>();
  const locks = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  let active = true;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("Incognito compute scope is closed");
    }
    params.assertAuthority();
    params.assertBorrowed();
    for (const source of selected.values()) {
      source.assertCurrent();
    }
  };
  const ownResources = (captured: SqliteWorkerCommand<IncognitoComputeOperations>) => {
    if (
      captured.type === "session.compute.source.release" ||
      captured.type === "session.compute.usage.releaseLock" ||
      captured.type === "session.compute.store.releaseLock"
    ) {
      throw new Error("Incognito compute cleanup belongs to its scope");
    }
    if ("sourceId" in captured.input) {
      const key = captured.input.sourceId;
      if (captured.type === "session.compute.source.open" && !sources.has(key)) {
        const { sessionKey, sessionId, lifecycleRevision, historical } = captured.input;
        sources.set(key, {
          sourceId: randomUUID(),
          target: { sessionKey, sessionId, lifecycleRevision, historical },
        });
      }
      const owned = sources.get(key);
      if (!owned) {
        throw new Error("Incognito compute source is not owned by this scope");
      }
      captured.input.sourceId = owned.sourceId;
    }
    if (
      captured.type === "session.compute.usage.acquireLock" ||
      captured.type === "session.compute.store.acquireLock"
    ) {
      const request = captured.input.request;
      request.lockJson = JSON.stringify({
        pid: process.pid,
        startedAt: request.startedAt,
        ownerNonce: randomUUID(),
      });
      locks.add(request.lockJson);
    }
  };
  return (async () => {
    try {
      assertCurrent();
      const result = await params.operation({
        assertCurrent,
        execute(command) {
          assertCurrent();
          const captured = structuredClone(command);
          const input = captured.input;
          if (
            target &&
            (isIncognitoStoreComputeCommand(captured) ||
              !("sessionKey" in input) ||
              input.sessionKey !== target.sessionKey ||
              input.sessionId !== target.sessionId ||
              input.lifecycleRevision !== target.lifecycleRevision ||
              input.historical !== target.historical)
          ) {
            throw new Error("Incognito compute request belongs to another session generation");
          }
          if (isIncognitoComputeCommand(captured)) {
            ownResources(captured);
          }
          const work = params.execute(captured, observeFacts).then((value) => {
            assertCurrent();
            disclose();
            assertCurrent();
            return value;
          });
          pending.add(work);
          void work.finally(() => pending.delete(work)).catch(() => undefined);
          return work;
        },
      });
      assertCurrent();
      disclose();
      assertCurrent();
      return result;
    } finally {
      active = false;
      await Promise.allSettled(pending);
      for (const { sourceId, target: sourceTarget } of sources.values()) {
        while (
          await params.cleanup({
            type: "session.compute.source.release",
            input: { ...sourceTarget, sourceId },
          })
        ) {
          // Each acknowledged chunk releases its FIFO turn before the next cleanup chunk.
        }
      }
      for (const lockJson of locks) {
        await params.cleanup(
          target
            ? {
                type: "session.compute.usage.releaseLock",
                input: { ...target, request: lockJson },
              }
            : { type: "session.compute.store.releaseLock", input: { request: lockJson } },
        );
      }
    }
  })();
}
