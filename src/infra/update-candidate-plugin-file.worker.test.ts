import { constants } from "node:fs";
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

function pool() {
  return new WorkerTaskPool<UpdateCandidatePluginFileRequest, UpdateCandidatePluginFileReply>({
    workerUrl: resolveRuntimeProcessEntrypointUrl("updateCandidateState"),
    maxWorkers: 1,
    maxPendingTasks: 1,
    restartOnError: false,
  });
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

it.each(["root", "ancestor"] as const)(
  "rejects a replaced %s before a worker can admit a new destination",
  async (replacement) => {
    const f = await fixture();
    const retired = path.join(f.base, "retired");
    if (replacement === "root") {
      await fs.rename(f.privateRoot, retired);
      await fs.mkdir(f.destination, { recursive: true });
    } else {
      await fs.rename(f.owner, retired);
      await fs.symlink(retired, f.owner, "junction");
    }
    const worker = pool();
    try {
      const reply = await worker.run(f.request, {});
      expect(reply.type).toBe("failed");
      expect(await fs.readdir(f.destination)).toEqual([]);
      expect(await fs.readFile(f.request.entry.path, "utf8")).toBe("plugin payload 0");
    } finally {
      await worker.close();
    }
  },
);

it("preserves create-only copy diagnostics across the worker boundary", async () => {
  const f = await fixture();
  await fs.writeFile(f.request.destination, "existing private bytes");
  const worker = pool();
  try {
    const reply = await worker.run(f.request, {});
    expect(reply).toMatchObject({ type: "failed", code: "already-exists" });
    expect(await fs.readFile(f.request.destination, "utf8")).toBe("existing private bytes");
    expect(await fs.readFile(f.request.entry.path, "utf8")).toBe("plugin payload 0");
  } finally {
    await worker.close();
  }
});

it("rejects source changes after the parent freezes the inventory", async () => {
  const f = await fixture();
  await fs.chmod(f.request.entry.path, 0o600);
  await fs.writeFile(f.request.entry.path, "altered payload!");
  const worker = pool();
  try {
    const reply = await worker.run(f.request, {});
    expect(reply.type).toBe("failed");
    if (reply.type === "failed") {
      expect(reply.error.message).toContain("changed after snapshot inventory");
    }
    expect(await fs.readdir(f.destination)).toEqual([]);
  } finally {
    await worker.close();
  }
});

it.each(["file", "parent"] as const)(
  "rejects a replaced source %s through the actual hash worker",
  async (replacement) => {
    const f = await fixture();
    const entry = f.request.entry;
    const request: UpdateCandidatePluginHashRequest = {
      type: "snapshot-hash",
      filePath: entry.path,
      expected: {
        dev: BigInt(entry.dev),
        ino: BigInt(entry.ino),
        size: BigInt(entry.size),
        birthtimeNs: BigInt(entry.birthtimeNs),
        mtimeNs: BigInt(entry.mtimeNs),
        ctimeNs: BigInt(entry.ctimeNs),
        mode: BigInt(entry.mode | constants.S_IFREG),
        uid: BigInt(entry.uid),
        gid: BigInt(entry.gid),
      },
    };
    const worker = new WorkerTaskPool<
      UpdateCandidatePluginHashRequest,
      UpdateCandidatePluginHashReply
    >({
      workerUrl: resolveRuntimeProcessEntrypointUrl("updateCandidateState"),
      maxWorkers: 1,
      maxPendingTasks: 1,
      restartOnError: false,
    });
    try {
      expect(await worker.run(request, {})).toEqual({ type: "hashed", sha256: entry.sha256 });
      const original = await fs.readFile(entry.path);
      await fs.rename(replacement === "file" ? entry.path : f.source, path.join(f.base, "retired"));
      if (replacement === "parent") {
        await fs.mkdir(f.source);
      }
      await fs.writeFile(entry.path, original, { mode: entry.mode });
      const reply = await worker.run(request, {});
      expect(reply.type).toBe("failed");
      if (reply.type === "failed") {
        expect(reply.error.message).toContain("File changed while hashing snapshot");
      }
      expect(await fs.readdir(f.destination)).toEqual([]);
    } finally {
      await worker.close();
    }
  },
);
