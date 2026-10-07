import fs from "node:fs/promises";
import path from "node:path";
import { readDirectoryIdentity } from "@openclaw/fs-safe/advanced";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import type {
  UpdateCandidatePluginFileReply,
  UpdateCandidatePluginFileRequest,
} from "./update-candidate-plugin-file.js";
import {
  copyUpdateCandidatePluginTrees,
  prepareUpdateCandidatePluginTrees,
} from "./update-candidate-plugin-tree.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

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
    const f = await fixture(1024);
    await copyUpdateCandidatePluginTrees(f.plan, {
      targetStateDir: f.privateRoot,
      candidateRoot: f.candidateRoot,
    });
    expect(await fs.readdir(f.destination)).toHaveLength(1024);
    for (const index of [0, 511, 1023]) {
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
