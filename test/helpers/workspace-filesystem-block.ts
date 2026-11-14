import { pathToFileURL } from "node:url";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import * as workerCpu from "../../src/infra/worker-cpu.js";

/** Block an actual worker filesystem observation while its host continues processing retirement. */
export function useWorkspaceFilesystemBlock(
  method: "statSync" | "lstat" | "mutationExists" = "statSync",
) {
  const words = new Int32Array(new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT));
  const pathname = new Uint8Array(new SharedArrayBuffer(16 * 1024));
  let restore: (() => void) | undefined;
  const release = () => {
    Atomics.store(words, 0, 0);
    Atomics.store(words, 1, 1);
    Atomics.notify(words, 1);
    Atomics.store(words, 2, 1);
    Atomics.notify(words, 2);
  };
  const install = () => {
    restore?.();
    const create = workerCpu.createCpuTrackedWorker;
    const spy = vi
      .spyOn(workerCpu, "createCpuTrackedWorker")
      .mockImplementation((filename, options) => {
        if (options?.eval) {
          return create(filename, options);
        }
        const key = "openclaw.test.workspaceFilesystemBlock";
        const previous = getEnvironmentData(key);
        setEnvironmentData(key, {
          entry: (typeof filename === "string" ? pathToFileURL(filename) : filename).href,
          words: words.buffer,
          pathname: pathname.buffer,
          method,
        });
        try {
          return create(
            new URL("./workspace-filesystem-block.worker.mjs", import.meta.url),
            options,
          );
        } finally {
          setEnvironmentData(key, previous);
        }
      });
    restore = () => spy.mockRestore();
  };
  beforeAll(install);
  beforeEach(install);
  afterEach(() => {
    release();
    restore?.();
  });
  afterAll(() => restore?.());
  return {
    arm(path: string, observation: number) {
      const encoded = Buffer.from(path);
      if (encoded.length > pathname.byteLength) {
        throw new Error("Workspace observation path exceeds the test fixture bound");
      }
      pathname.set(encoded);
      Atomics.store(words, 3, encoded.length);
      Atomics.store(words, 1, 0);
      Atomics.store(words, 2, 0);
      Atomics.store(words, 0, observation);
      return Promise.resolve(Atomics.waitAsync(words, 1, 0).value);
    },
    release,
  };
}
