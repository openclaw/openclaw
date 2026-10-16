import { pathToFileURL } from "node:url";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import * as workerCpu from "../../src/infra/worker-cpu.js";

type SqliteWorkerFault = {
  name: string;
  match: RegExp;
  sql: string;
};

/** Register before fixture setup so retained workers inherit the disabled fault controls. */
export function useSqliteWorkerFault(rules: readonly SqliteWorkerFault[]) {
  const enabled = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * rules.length),
  );
  let restore: (() => void) | undefined;
  const install = () => {
    restore?.();
    const create = workerCpu.createCpuTrackedWorker;
    const observed = vi
      .spyOn(workerCpu, "createCpuTrackedWorker")
      .mockImplementation((filename, options) => {
        if (options?.eval) {
          return create(filename, options);
        }
        const entry = typeof filename === "string" ? pathToFileURL(filename) : filename;
        const key = "openclaw.test.sqliteWorkerFault";
        const previous = getEnvironmentData(key);
        setEnvironmentData(key, {
          entry: entry.href,
          enabled: enabled.buffer,
          rules: rules.map(({ match, ...rule }) => ({
            ...rule,
            pattern: match.source,
            flags: match.flags,
          })),
        });
        try {
          return create(new URL("./sqlite-worker-fault.worker.mjs", import.meta.url), options);
        } finally {
          setEnvironmentData(key, previous);
        }
      });
    restore = () => observed.mockRestore();
  };
  beforeAll(install);
  beforeEach(install);
  const disable = () => {
    for (let index = 0; index < rules.length; index++) {
      Atomics.store(enabled, index, 0);
    }
  };
  afterEach(() => {
    disable();
    restore?.();
  });
  afterAll(() => restore?.());
  return {
    enable(index = 0) {
      Atomics.store(enabled, index, 1);
    },
    disable,
  };
}
