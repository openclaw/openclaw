import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { hashFileMutationSnapshotSync } from "./file-descriptor.js";
import type { UpdateCandidatePluginHashRequest } from "./update-candidate-plugin-hash.js";
import {
  copyUpdateCandidatePluginTrees,
  prepareUpdateCandidatePluginTrees,
} from "./update-candidate-plugin-tree.js";

const transport = vi.hoisted(() => ({
  construct: vi.fn<(options: unknown) => void>(),
  run: vi.fn<(input: unknown, options: unknown) => Promise<unknown>>(),
  close: vi.fn<() => Promise<void>>(),
}));
vi.mock("./worker-task-pool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-task-pool.js")>()),
  WorkerTaskPool: class {
    constructor(options: unknown) {
      transport.construct(options);
    }
    run(input: unknown, options: unknown) {
      return transport.run(input, options);
    }
    close() {
      return transport.close();
    }
  },
}));

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  transport.construct.mockReset();
  transport.run.mockReset();
  transport.close.mockReset();
});

it.each(["settled", "failed"] as const)(
  "drains accepted copies and joins %s pool retirement before reporting failure",
  async (retirement) => {
    const base = await fs.realpath(directories.make("update-copy-scheduling-"));
    const source = path.join(base, "source");
    const targetStateDir = path.join(base, "snapshot");
    const candidateRoot = path.join(base, "candidate");
    const destination = path.join(targetStateDir, "plugin");
    await fs.mkdir(source);
    await fs.mkdir(candidateRoot);
    const payload = path.join(source, "0.txt");
    await fs.writeFile(payload, "plugin bytes");
    for (let index = 1; index < 1024; index += 1) {
      await fs.link(payload, path.join(source, `${index}.txt`));
    }
    await fs.symlink("0.txt", path.join(source, "payload-link"), "file");
    // Inventory has its own read-only pool; this test gates the later copy owner.
    transport.run.mockImplementation(async (input) => {
      const request = input as UpdateCandidatePluginHashRequest;
      expect(request.type).toBe("snapshot-hash");
      return {
        type: "hashed",
        sha256: hashFileMutationSnapshotSync(request.filePath, request.expected),
      };
    });
    const plan = await prepareUpdateCandidatePluginTrees({
      roots: new Map([[source, destination]]),
      project: (file) => path.join(destination, path.relative(source, file)),
      targetStateDir,
      candidateRoot,
    });
    transport.close.mockClear();
    const entered = createDeferredCore();
    const failFirst = createDeferredCore();
    const firstFailed = createDeferredCore();
    const releasePeers = createDeferredCore();
    const closing = createDeferredCore();
    const releaseClose = createDeferredCore();
    const copyFailure = Object.assign(new Error("copy refused"), { code: "already-exists" });
    const closeFailure = new Error("worker retirement could not be verified");
    let started = 0;
    let active = 0;
    let settled = false;
    transport.run.mockImplementation(async () => {
      const index = started++;
      active += 1;
      if (started === 4) {
        entered.resolve();
      }
      try {
        if (index === 0) {
          await failFirst.promise;
          firstFailed.resolve();
          return { type: "failed", error: copyFailure, code: copyFailure.code };
        }
        await releasePeers.promise;
        return { type: "copied" };
      } finally {
        active -= 1;
      }
    });
    transport.close.mockImplementation(async () => {
      expect(active).toBe(0);
      closing.resolve();
      await releaseClose.promise;
      if (retirement === "failed") {
        throw closeFailure;
      }
    });
    const publishLink = vi.spyOn(fs, "symlink");
    const copying = copyUpdateCandidatePluginTrees(plan, { targetStateDir, candidateRoot }).catch(
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await awaitGateBeforeSettlement(entered.promise, copying, "four copies were not admitted");
      failFirst.resolve();
      await firstFailed.promise;
      expect(settled).toBe(false);
      expect(transport.close).not.toHaveBeenCalled();
      expect(publishLink).not.toHaveBeenCalled();
      releasePeers.resolve();
      await awaitGateBeforeSettlement(closing.promise, copying, "pool retirement was not joined");
      expect(started).toBe(4);
      expect(settled).toBe(false);
      expect(publishLink).not.toHaveBeenCalled();
      releaseClose.resolve();
      expect(await copying).toBe(retirement === "failed" ? closeFailure : copyFailure);
      expect(transport.construct).toHaveBeenCalledWith(
        expect.objectContaining({ maxWorkers: 4, maxPendingTasks: 4, restartOnError: false }),
      );
      expect(transport.run).toHaveBeenCalledWith(expect.any(Object), {});
      expect(await fs.readdir(destination)).toEqual([]);
    } finally {
      failFirst.resolve();
      releasePeers.resolve();
      releaseClose.resolve();
      await copying;
    }
  },
);
