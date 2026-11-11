import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";

export function trackBaseLookupCallers(repo: string, count: number) {
  const current = new AsyncLocalStorage<number>();
  const seen = new Set<number>();
  const ready = createDeferred();
  const observe = () => {
    const caller = current.getStore();
    if (caller !== undefined) {
      seen.add(caller);
      if (seen.size === count) {
        ready.resolve();
      }
    }
  };
  const realpath = fs.realpath;
  vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
    const result = await realpath(...args);
    if (result === repo) {
      observe();
    }
    return result;
  });
  return {
    ready: ready.promise,
    run: <T>(index: number, run: () => T) => current.run(index, run),
    observeCommand: (args: string[]) => {
      // Uncoalesced implementations reach discovery without resolving a sharing key.
      if (args[0] === "symbolic-ref" && args[1] === "--quiet") {
        observe();
      }
    },
  };
}
