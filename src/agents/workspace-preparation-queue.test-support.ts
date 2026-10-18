import path from "node:path";
import { expect, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as workspaceState from "./workspace-state-store.js";

export function holdWorkspacePreparationSnapshot(directories: string | readonly string[]) {
  const paths = new Set(
    (typeof directories === "string" ? [directories] : directories).map((dir) => path.resolve(dir)),
  );
  const entered = createDeferred();
  const release = createDeferred();
  const calls: Promise<unknown>[] = [];
  const overlappingReads: string[] = [];
  const readSnapshot = workspaceState.readWorkspaceStateSnapshot;
  let held = false;
  let released = false;
  let failure: Error | undefined;
  const spy = vi
    .spyOn(workspaceState, "readWorkspaceStateSnapshot")
    .mockImplementation(async (...args) => {
      if (!paths.has(path.resolve(args[0]))) {
        return await readSnapshot(...args);
      }
      if (held) {
        if (!released) {
          overlappingReads.push(args[0]);
        }
        return await readSnapshot(...args);
      }
      held = true;
      const snapshot = await readSnapshot(...args);
      entered.resolve();
      await release.promise;
      if (failure) {
        throw failure;
      }
      return snapshot;
    });
  const finish = (error?: Error) => {
    failure = error;
    released = true;
    release.resolve();
  };
  return {
    entered: entered.promise,
    run<T>(work: () => Promise<T>): Promise<T> {
      const pending = work();
      void pending.catch(() => undefined);
      calls.push(pending);
      return pending;
    },
    ready(operation: Promise<unknown>, signal: AbortSignal) {
      return withinTest(
        awaitGateBeforeSettlement(entered.promise, operation, "Workspace snapshot was not reached"),
        signal,
      );
    },
    expectQueued() {
      expect(overlappingReads).toEqual([]);
    },
    release: finish,
    async dispose(extraOperations: readonly (Promise<unknown> | undefined)[] = []) {
      finish(failure);
      await Promise.allSettled([...calls, ...extraOperations]);
      spy.mockRestore();
    },
  };
}
