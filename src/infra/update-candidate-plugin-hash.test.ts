import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hashFileMutationSnapshotSync } from "./file-descriptor.js";
import type { UpdateCandidatePluginHashRequest } from "./update-candidate-plugin-hash.js";
import {
  expectDrainedWorkerFailure,
  pluginTreeFixture,
} from "./update-candidate-plugin-scheduling.test-support.js";

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

const fixture = (count: number) =>
  pluginTreeFixture(directories.make("update-hash-scheduling-"), count);

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
    const failure = Object.assign(new Error("source changed"), {
      code: "identity-mismatch",
      details: { stage: "hash" },
    });
    const closeFailure = new Error("hash worker retirement unconfirmed");
    const failed = await expectDrainedWorkerFailure(transport, {
      start: f.prepare,
      inspect: (request) => {
        expect(request.type).toBe("snapshot-hash");
        for (const value of Object.values(request.expected)) {
          expect(typeof value).toBe("bigint");
        }
      },
      failedReply: {
        type: "failed",
        error: new Error(failure.message),
        code: failure.code,
        details: failure.details,
      },
      reply: (request) => ({
        type: "hashed",
        sha256: hashFileMutationSnapshotSync(request.filePath, request.expected),
      }),
      closeFailure: retirement === "failed" ? closeFailure : undefined,
    });
    if (retirement === "failed") {
      expect(failed).toBe(closeFailure);
    } else {
      expect(failed).toMatchObject({
        message: failure.message,
        code: failure.code,
        details: failure.details,
      });
    }
    expect(transport.construct).toHaveBeenCalledWith(
      expect.objectContaining({ maxWorkers: 4, maxPendingTasks: 4, restartOnError: false }),
    );
    expect(transport.run).toHaveBeenCalledWith(expect.any(Object), {});
  },
);

it("refuses a stale worker reply instead of publishing an inventory without hashes", async () => {
  const f = await fixture(1024);
  transport.run.mockResolvedValue({ type: "copied" });
  transport.close.mockResolvedValue();
  await expect(f.prepare()).rejects.toThrow("Unexpected update inventory hash worker reply");
  expect(transport.close).toHaveBeenCalledOnce();
});
