import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hashFileMutationSnapshotSync } from "./file-descriptor.js";
import type { UpdateCandidatePluginHashRequest } from "./update-candidate-plugin-hash.js";
import {
  expectDrainedWorkerFailure,
  pluginTreeFixture,
} from "./update-candidate-plugin-scheduling.test-support.js";

const transport = vi.hoisted(() => ({
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
    run = transport.run;
    close = transport.close;
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
  transport.run.mockReset();
  transport.close.mockReset();
});

const fixture = (count: number) =>
  pluginTreeFixture(directories.make("update-hash-scheduling-"), count);

it.each(["settled", "failed"] as const)(
  "stops hash admission, drains peers, and joins %s worker retirement before returning",
  async (retirement) => {
    const f = await fixture(1032);
    const failure = {
      message: "source changed",
      code: "identity-mismatch",
      details: { stage: "hash" },
    };
    const closeFailure = new Error("hash worker retirement unconfirmed");
    const failed = await expectDrainedWorkerFailure(transport, {
      start: f.prepare,
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
      expect(failed).toMatchObject(failure);
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
