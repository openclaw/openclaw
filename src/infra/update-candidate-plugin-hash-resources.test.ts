import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hashFileMutationSnapshotSync } from "./file-descriptor.js";
import {
  withUpdateCandidatePluginFileHashing,
  type UpdateCandidatePluginHashRequest,
} from "./update-candidate-plugin-hash.js";

const resources = vi.hoisted(() => ({
  parallelism: vi.fn(() => 8),
  construct: vi.fn<(options: unknown) => void>(),
  close: vi.fn<() => Promise<void>>(),
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: resources.parallelism,
}));
vi.mock("./worker-task-pool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-task-pool.js")>()),
  WorkerTaskPool: class {
    constructor(options: unknown) {
      resources.construct(options);
    }
    async run(request: UpdateCandidatePluginHashRequest) {
      return {
        type: "hashed",
        sha256: hashFileMutationSnapshotSync(request.filePath, request.expected),
      };
    }
    close() {
      return resources.close();
    }
  },
}));
// mock-isolation: Resource admission is tested before compiled-worker startup; real transport has its own worker suite.
vi.mock("./runtime-process-url.js", () => ({
  resolveRuntimeProcessEntrypointUrl: () => new URL("file:///update-inventory.worker.js"),
}));

const directories = useAutoCleanupTempDirTracker(afterEach);
const MiB = 1024 * 1024;
const originalVersions = process.versions;
const originalPlatform = process.platform;
beforeEach(() => {
  resources.construct.mockClear();
  resources.close.mockReset().mockResolvedValue();
});
afterEach(() => {
  Object.defineProperty(process, "versions", { value: originalVersions });
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.restoreAllMocks();
});

it.each([
  { name: "ample resources", cpus: 8, memory: 4096, workers: 4 },
  { name: "two CPUs", cpus: 2, memory: 4096, workers: 1 },
  { name: "one CPU", cpus: 1, memory: 4096, workers: 0 },
  { name: "one GiB available", cpus: 8, memory: 1024, workers: 2 },
  { name: "768 MiB available", cpus: 8, memory: 768, workers: 1 },
  { name: "low memory", cpus: 8, memory: 256, workers: 0 },
  { name: "unknown memory", cpus: 8, memory: 0, workers: 0 },
  { name: "invalid memory", cpus: 8, memory: Infinity, workers: 0 },
  {
    name: "Bun Linux host-only memory",
    cpus: 8,
    memory: 65536,
    workers: 0,
    bun: "1.4.3",
  },
])("preserves every digest with $name", async ({ cpus, memory, workers, bun }) => {
  resources.parallelism.mockReturnValue(cpus);
  const availableMemory = vi.spyOn(process, "availableMemory").mockReturnValue(memory * MiB);
  Object.defineProperty(process, "versions", { value: { ...originalVersions, bun } });
  Object.defineProperty(process, "platform", { value: "linux" });
  const file = path.join(directories.make("update-hash-resources-"), "payload");
  const payload = "bounded inventory payload";
  await fs.writeFile(file, payload);
  const expected = await fs.stat(file, { bigint: true });
  const digest = createHash("sha256").update(payload).digest("hex");
  await withUpdateCandidatePluginFileHashing(async (hash) => {
    for (let index = 0; index < 1032; index++) {
      expect(await hash(file, expected)).toBe(digest);
    }
  });
  if (workers === 0) {
    expect(resources.construct).not.toHaveBeenCalled();
    expect(resources.close).not.toHaveBeenCalled();
  } else {
    expect(resources.construct).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ maxWorkers: workers, maxPendingTasks: 4, restartOnError: false }),
    );
    expect(resources.close).toHaveBeenCalledOnce();
  }
  // One admission snapshot, not a new process-memory probe for every file.
  expect(availableMemory.mock.calls.length).toBeLessThanOrEqual(1);
});
