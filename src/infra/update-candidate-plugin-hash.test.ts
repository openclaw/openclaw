import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { hashFileMutationSnapshotSync } from "./file-descriptor.js";
import type { UpdateCandidatePluginHashRequest } from "./update-candidate-plugin-hash.js";
import { prepareUpdateCandidatePluginTrees } from "./update-candidate-plugin-tree.js";

const transport = vi.hoisted(() => ({
  construct: vi.fn<(options: unknown) => void>(),
  run: vi.fn<(input: UpdateCandidatePluginHashRequest, options: unknown) => Promise<unknown>>(),
  close: vi.fn<() => Promise<void>>(),
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 8,
}));
vi.mock("./worker-task-pool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-task-pool.js")>()),
  WorkerTaskPool: class {
    constructor(options: unknown) {
      transport.construct(options);
    }
    run(input: UpdateCandidatePluginHashRequest, options: unknown) {
      return transport.run(input, options);
    }
    close() {
      return transport.close();
    }
  },
}));
// mock-isolation: A gated fake transport must not initialize compiled subprocesses; actual worker coverage lives in update-candidate-plugin-file.worker.test.ts.
vi.mock("./runtime-process-url.js", () => ({
  resolveRuntimeProcessEntrypointUrl: () => new URL("file:///update-inventory.worker.js"),
}));

const directories = useAutoCleanupTempDirTracker(afterEach);
const originalVersions = process.versions;
beforeEach(() => {
  // These gates exercise admitted-worker custody; resource refusal has a separate suite.
  Object.defineProperty(process, "versions", { value: { ...originalVersions, bun: undefined } });
  vi.spyOn(process, "availableMemory").mockReturnValue(4 * 1024 ** 3);
});
afterEach(() => {
  Object.defineProperty(process, "versions", { value: originalVersions });
  vi.restoreAllMocks();
  transport.construct.mockReset();
  transport.run.mockReset();
  transport.close.mockReset();
});

async function fixture(count: number) {
  const base = await fs.realpath(directories.make("update-hash-scheduling-"));
  const source = path.join(base, "source");
  const targetStateDir = path.join(base, "snapshot");
  const candidateRoot = path.join(base, "candidate");
  const destination = path.join(targetStateDir, "plugin");
  await fs.mkdir(source);
  await fs.mkdir(candidateRoot);
  const payload = path.join(source, "0.txt");
  await fs.writeFile(payload, "inventory bytes");
  for (let index = 1; index < count; index += 1) {
    await fs.link(payload, path.join(source, `${index}.txt`));
  }
  return {
    source,
    prepare: () =>
      prepareUpdateCandidatePluginTrees({
        roots: new Map([[source, destination]]),
        project: (file) => path.join(destination, path.relative(source, file)),
        targetStateDir,
        candidateRoot,
      }),
  };
}

it("hashes small inventories without creating workers", async () => {
  const f = await fixture(3);
  const plan = await f.prepare();
  const files = plan.entries.filter((entry) => entry.kind === "file");
  expect(files).toHaveLength(3);
  expect(new Set(files.map((entry) => entry.sha256)).size).toBe(1);
  expect(transport.construct).not.toHaveBeenCalled();
});

it.each(["settled", "failed"] as const)(
  "stops hash admission, drains peers, and joins %s worker retirement before returning",
  async (retirement) => {
    const f = await fixture(1032);
    const entered = createDeferredCore();
    const failFirst = createDeferredCore();
    const firstFailed = createDeferredCore();
    const releasePeers = createDeferredCore();
    const closing = createDeferredCore();
    const releaseClose = createDeferredCore();
    const failure = Object.assign(new Error("source changed"), {
      code: "identity-mismatch",
      details: { stage: "hash" },
    });
    const closeFailure = new Error("hash worker retirement unconfirmed");
    let started = 0;
    let active = 0;
    let settled = false;
    transport.run.mockImplementation(async (request) => {
      expect(request.type).toBe("snapshot-hash");
      for (const value of Object.values(request.expected)) {
        expect(typeof value).toBe("bigint");
      }
      const index = started++;
      active += 1;
      if (started === 4) {
        entered.resolve();
      }
      try {
        if (index === 0) {
          await failFirst.promise;
          firstFailed.resolve();
          return {
            type: "failed",
            error: new Error(failure.message),
            code: failure.code,
            details: failure.details,
          };
        }
        await releasePeers.promise;
        return {
          type: "hashed",
          sha256: hashFileMutationSnapshotSync(request.filePath, request.expected),
        };
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
    const preparing = f.prepare().then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await awaitGateBeforeSettlement(entered.promise, preparing, "four hashes were not admitted");
      failFirst.resolve();
      await firstFailed.promise;
      expect(settled).toBe(false);
      expect(transport.close).not.toHaveBeenCalled();
      releasePeers.resolve();
      await awaitGateBeforeSettlement(closing.promise, preparing, "hash retirement was not joined");
      expect(started).toBe(4);
      expect(settled).toBe(false);
      releaseClose.resolve();
      if (retirement === "failed") {
        expect(await preparing).toBe(closeFailure);
      } else {
        expect(await preparing).toMatchObject({
          message: failure.message,
          code: failure.code,
          details: failure.details,
        });
      }
      expect(transport.construct).toHaveBeenCalledWith(
        expect.objectContaining({ maxWorkers: 4, maxPendingTasks: 4, restartOnError: false }),
      );
      expect(transport.run).toHaveBeenCalledWith(expect.any(Object), {});
    } finally {
      failFirst.resolve();
      releasePeers.resolve();
      releaseClose.resolve();
      await preparing;
    }
  },
);

it("refuses a stale worker reply instead of publishing an inventory without hashes", async () => {
  const f = await fixture(1024);
  transport.run.mockResolvedValue({ type: "copied" });
  transport.close.mockResolvedValue();
  await expect(f.prepare()).rejects.toThrow("Unexpected update inventory hash worker reply");
  expect(transport.close).toHaveBeenCalledOnce();
});
