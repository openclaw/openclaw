import { randomUUID } from "node:crypto";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  isIncognitoComputeCommand,
  type IncognitoComputeOperations,
  type IncognitoComputeTarget,
} from "./session-incognito-compute-contract.js";

export type IncognitoComputeScope = {
  assertCurrent(this: void): void;
  execute<Key extends keyof IncognitoComputeOperations>(command: {
    type: Key;
    input: IncognitoComputeOperations[Key]["input"];
  }): Promise<IncognitoComputeOperations[Key]["output"]>;
};

/** Cleanup owns only resources captured before dispatch; it never grants data access. */
export async function withIncognitoCompute<T>(params: {
  target: IncognitoComputeTarget;
  assertCurrent(this: void): void;
  disclose(): void;
  execute: IncognitoComputeScope["execute"];
  cleanup: IncognitoComputeScope["execute"];
  operation(scope: IncognitoComputeScope): Promise<T>;
}): Promise<T> {
  const target = structuredClone(params.target);
  const sources = new Map<string, string>();
  const locks = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  let active = true;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("Incognito compute scope is closed");
    }
    params.assertCurrent();
  };
  const ownResources = (captured: SqliteWorkerCommand<IncognitoComputeOperations>) => {
    if (
      captured.type === "session.compute.source.release" ||
      captured.type === "session.compute.usage.releaseLock"
    ) {
      throw new Error("Incognito compute cleanup belongs to its scope");
    }
    if ("sourceId" in captured.input) {
      const key = captured.input.sourceId;
      if (captured.type === "session.compute.source.open" && !sources.has(key)) {
        sources.set(key, randomUUID());
      }
      const owned = sources.get(key);
      if (!owned) {
        throw new Error("Incognito compute source is not owned by this scope");
      }
      captured.input.sourceId = owned;
    }
    if (captured.type === "session.compute.usage.acquireLock") {
      const request = captured.input.request;
      request.lockJson = JSON.stringify({
        pid: process.pid,
        startedAt: request.startedAt,
        ownerNonce: randomUUID(),
      });
      locks.add(request.lockJson);
    }
  };
  try {
    assertCurrent();
    const result = await params.operation({
      assertCurrent,
      execute(command) {
        assertCurrent();
        const captured = structuredClone(command);
        const input = captured.input;
        if (
          input.sessionKey !== target.sessionKey ||
          input.sessionId !== target.sessionId ||
          input.lifecycleRevision !== target.lifecycleRevision
        ) {
          throw new Error("Incognito compute request belongs to another session generation");
        }
        if (isIncognitoComputeCommand(captured)) {
          ownResources(captured);
        }
        const work = params.execute(captured).then((value) => {
          assertCurrent();
          params.disclose();
          assertCurrent();
          return value;
        });
        pending.add(work);
        void work.finally(() => pending.delete(work)).catch(() => undefined);
        return work;
      },
    });
    assertCurrent();
    params.disclose();
    assertCurrent();
    return result;
  } finally {
    active = false;
    await Promise.allSettled(pending);
    for (const sourceId of sources.values()) {
      while (
        await params.cleanup({
          type: "session.compute.source.release",
          input: { ...target, sourceId },
        })
      ) {
        // Each acknowledged chunk releases its FIFO turn before the next cleanup chunk.
      }
    }
    for (const lockJson of locks) {
      await params.cleanup({
        type: "session.compute.usage.releaseLock",
        input: { ...target, request: lockJson },
      });
    }
  }
}
