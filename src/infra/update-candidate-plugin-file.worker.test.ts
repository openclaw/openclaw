import fs from "node:fs/promises";
import path from "node:path";
import { readDirectoryIdentity } from "@openclaw/fs-safe/advanced";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import type {
  UpdateCandidatePluginFileReply,
  UpdateCandidatePluginFileRequest,
} from "./update-candidate-plugin-file.js";
import type {
  UpdateCandidatePluginHashReply,
  UpdateCandidatePluginHashRequest,
} from "./update-candidate-plugin-hash.js";
import {
  copyUpdateCandidatePluginTrees,
  prepareUpdateCandidatePluginTrees,
} from "./update-candidate-plugin-tree.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 8,
}));

const directories = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  vi.spyOn(process, "availableMemory").mockReturnValue(4 * 1024 ** 3);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function fixture(count = 1) {
  const base = await fs.realpath(directories.make("update-file-workers-"));
  const source = path.join(base, "source");
  const owner = path.join(base, "owner");
  const privateRoot = path.join(owner, "snapshot");
  const destination = path.join(privateRoot, "plugin");
  const candidateRoot = path.join(base, "candidate");
  await fs.mkdir(source);
  await fs.mkdir(candidateRoot);
  await fs.mkdir(destination, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    await fs.writeFile(path.join(source, `${index}.txt`), `plugin payload ${index}`);
  }
  await fs.chmod(path.join(source, "0.txt"), 0o444);
  const plan = await prepareUpdateCandidatePluginTrees({
    roots: new Map([[source, destination]]),
    project: (file) => path.join(destination, path.relative(source, file)),
    targetStateDir: privateRoot,
    candidateRoot,
  });
  const entry = plan.entries.find((item) => item.kind === "file");
  if (entry?.kind !== "file") {
    throw new Error("Missing fixture file");
  }
  const request: UpdateCandidatePluginFileRequest = {
    privateRoot,
    rootIdentity: await readDirectoryIdentity(privateRoot),
    destination: path.join(destination, path.basename(entry.path)),
    entry,
  };
  return { base, source, owner, privateRoot, destination, candidateRoot, plan, request };
}

async function withWorker<
  Input = UpdateCandidatePluginFileRequest,
  Output = UpdateCandidatePluginFileReply,
>(run: (worker: WorkerTaskPool<Input, Output>) => Promise<void>) {
  const worker = new WorkerTaskPool<Input, Output>({
    workerUrl: resolveRuntimeProcessEntrypointUrl("updateCandidateState"),
    maxWorkers: 1,
    maxPendingTasks: 1,
    restartOnError: false,
  });
  try {
    await run(worker);
  } finally {
    await worker.close();
  }
}

it.each(["auto", "off"] as const)(
  "copies a large inventory through actual workers with native copying %s",
  async (nativeMode) => {
    vi.stubEnv("FS_SAFE_NATIVE_MODE", nativeMode);
    const dispatch = vi.spyOn(WorkerTaskPool.prototype, "run");
    const f = await fixture(1032);
    if (process.versions.bun && process.platform === "linux") {
      expect(dispatch).not.toHaveBeenCalled();
    } else {
      expect(dispatch).toHaveBeenCalledTimes(9);
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "snapshot-hash" }), {});
    }
    await copyUpdateCandidatePluginTrees(f.plan, {
      targetStateDir: f.privateRoot,
      candidateRoot: f.candidateRoot,
    });
    expect(await fs.readdir(f.destination)).toHaveLength(1032);
    for (const index of [0, 511, 1031]) {
      const original = path.join(f.source, `${index}.txt`);
      const copied = path.join(f.destination, `${index}.txt`);
      expect(await fs.readFile(copied, "utf8")).toBe(`plugin payload ${index}`);
      const [before, after] = await Promise.all([
        fs.stat(original, { bigint: true }),
        fs.stat(copied, { bigint: true }),
      ]);
      expect(after.ino).not.toBe(before.ino);
      expect(after.nlink).toBe(1n);
      if (process.platform !== "win32") {
        expect(after.mode & 0o777n).toBe(before.mode & 0o777n);
      }
    }
    const copied = path.join(f.destination, "0.txt");
    await fs.chmod(copied, 0o600);
    await fs.writeFile(copied, "private candidate edit");
    expect(await fs.readFile(path.join(f.source, "0.txt"), "utf8")).toBe("plugin payload 0");
  },
);

it.each(["root", "ancestor", "destination", "source"] as const)(
  "refuses a changed %s across the copy worker boundary",
  async (replacement) => {
    const f = await fixture();
    const retired = path.join(f.base, "retired");
    if (replacement === "root") {
      await fs.rename(f.privateRoot, retired);
      await fs.mkdir(f.destination, { recursive: true });
    } else if (replacement === "ancestor") {
      await fs.rename(f.owner, retired);
      await fs.symlink(retired, f.owner, "junction");
    } else if (replacement === "destination") {
      await fs.writeFile(f.request.destination, "existing private bytes");
    } else {
      await fs.chmod(f.request.entry.path, 0o600);
      await fs.writeFile(f.request.entry.path, "altered payload!");
    }
    await withWorker(async (worker) => {
      const reply = await worker.run(f.request, {});
      expect(reply.type).toBe("failed");
      expect(await fs.readdir(f.destination)).toEqual(
        replacement === "destination" ? ["0.txt"] : [],
      );
      if (replacement === "source") {
        expect(reply).toMatchObject({
          error: { message: expect.stringContaining("changed after snapshot inventory") },
        });
      } else {
        expect(await fs.readFile(f.request.entry.path, "utf8")).toBe("plugin payload 0");
      }
      if (replacement === "destination") {
        expect(reply).toMatchObject({ code: "already-exists" });
        expect(await fs.readFile(f.request.destination, "utf8")).toBe("existing private bytes");
      }
    });
  },
);

it.each(["file", "parent"] as const)(
  "rejects a replaced source %s through the actual hash worker",
  async (replacement) => {
    const f = await fixture();
    const entry = f.request.entry;
    const request: UpdateCandidatePluginHashRequest = {
      type: "snapshot-hash",
      filePath: entry.path,
      expected: await fs.lstat(entry.path, { bigint: true }),
    };
    await withWorker<UpdateCandidatePluginHashRequest, UpdateCandidatePluginHashReply>(
      async (worker) => {
        expect(await worker.run(request, {})).toEqual({ type: "hashed", sha256: entry.sha256 });
        const original = await fs.readFile(entry.path);
        await fs.rename(
          replacement === "file" ? entry.path : f.source,
          path.join(f.base, "retired"),
        );
        if (replacement === "parent") {
          await fs.mkdir(f.source);
        }
        await fs.writeFile(entry.path, original, { mode: entry.mode });
        const reply = await worker.run(request, {});
        expect(reply).toMatchObject({
          type: "failed",
          error: { message: expect.stringContaining("File changed while hashing snapshot") },
        });
        expect(await fs.readdir(f.destination)).toEqual([]);
      },
    );
  },
);
