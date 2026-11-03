import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hashFileMutationSnapshotSync } from "./file-descriptor.js";
import type { UpdateCandidatePluginHashRequest } from "./update-candidate-plugin-hash.js";
import {
  expectDrainedWorkerFailure,
  pluginTreeFixture,
} from "./update-candidate-plugin-scheduling.test-support.js";
import { copyUpdateCandidatePluginTrees } from "./update-candidate-plugin-tree.js";

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
    const f = await pluginTreeFixture(directories.make("update-copy-scheduling-"), 1024);
    const { source, destination } = f;
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
    const plan = await f.prepare();
    transport.close.mockClear();
    const copyFailure = Object.assign(new Error("copy refused"), { code: "already-exists" });
    const closeFailure = new Error("worker retirement could not be verified");
    const publishLink = vi.spyOn(fs, "symlink");
    const failure = await expectDrainedWorkerFailure(transport, {
      start: () => copyUpdateCandidatePluginTrees(plan, f),
      failedReply: { type: "failed", error: copyFailure, code: copyFailure.code },
      reply: () => ({ type: "copied" }),
      closeFailure: retirement === "failed" ? closeFailure : undefined,
      assertPending: () => expect(publishLink).not.toHaveBeenCalled(),
    });
    expect(failure).toBe(retirement === "failed" ? closeFailure : copyFailure);
    expect(transport.construct).toHaveBeenCalledWith(
      expect.objectContaining({ maxPendingTasks: 4, restartOnError: false }),
    );
    expect(transport.run).toHaveBeenCalledWith(expect.any(Object), {});
    expect(await fs.readdir(destination)).toEqual([]);
  },
);
