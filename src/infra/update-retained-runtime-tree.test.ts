import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareUpdateCandidatePluginTrees } from "./update-candidate-plugin-tree.js";
import { linkUpdateCandidatePluginTrees } from "./update-retained-runtime-tree.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const root = await fs.realpath(dirs.make("retained-runtime-link-"));
  const source = path.join(root, "source");
  const targetStateDir = path.join(root, "retained");
  const candidateRoot = path.join(root, "candidate");
  const destination = path.join(targetStateDir, "package");
  await fs.mkdir(path.join(source, "dist", "state"), { recursive: true });
  await fs.mkdir(path.join(source, "node_modules", ".bin"), { recursive: true });
  await fs.mkdir(candidateRoot);
  const worker = path.join(source, "dist", "state", "worker.js");
  await fs.writeFile(worker, "export const generation = 'retained';\n");
  await fs.chmod(worker, 0o444);
  // pnpm stores publish package files as hard links of one inode.
  await fs.link(worker, path.join(source, "dist", "worker-alias.js"));
  const launcher = path.join(source, "node_modules", ".bin", "tool");
  await fs.writeFile(launcher, `#!/bin/sh\nexec "$basedir/../tool/cli.js"\n`);
  await fs.symlink(
    path.join("..", "dist", "state", "worker.js"),
    path.join(source, "node_modules", "link.js"),
  );
  const plan = await prepareUpdateCandidatePluginTrees({
    roots: new Map([[source, destination]]),
    project: (entry) => path.join(destination, path.relative(source, entry)),
    targetStateDir,
    candidateRoot,
  });
  return {
    source,
    worker,
    launcher,
    destination,
    plan,
    link: () => linkUpdateCandidatePluginTrees(plan, { targetStateDir, candidateRoot }),
  };
}

it("retains files by hard link so the inodes outlive package replacement", async () => {
  const f = await fixture();
  const before = await fs.stat(f.worker, { bigint: true });
  const counts = await f.link();
  const retainedWorker = path.join(f.destination, "dist", "state", "worker.js");
  expect(counts).toEqual({ linked: 2, copied: 1 });
  expect((await fs.stat(retainedWorker, { bigint: true })).ino).toBe(before.ino);
  expect(
    (await fs.stat(path.join(f.destination, "dist", "worker-alias.js"), { bigint: true })).ino,
  ).toBe(before.ino);
  // The launcher is rewritten for its new location; the live package must not change.
  const retainedLauncher = path.join(f.destination, "node_modules", ".bin", "tool");
  expect((await fs.stat(retainedLauncher, { bigint: true })).ino).not.toBe(
    (await fs.stat(f.launcher, { bigint: true })).ino,
  );
  expect(await fs.readFile(f.launcher, "utf8")).toContain('"$basedir/../tool/cli.js"');
  expect(await fs.readlink(path.join(f.destination, "node_modules", "link.js"))).toBe(
    path.join("..", "dist", "state", "worker.js"),
  );
  const displaced = `${f.source}.previous`;
  await fs.rename(f.source, displaced);
  await fs.rm(displaced, { recursive: true });
  expect(await fs.readFile(retainedWorker, "utf8")).toBe("export const generation = 'retained';\n");
  expect((await fs.stat(retainedWorker)).mode & 0o777).toBe(0o444);
});

it.each([0, 1])("copies shared inode occurrence %i when hard links are refused", async (index) => {
  const f = await fixture();
  const before = await fs.stat(f.worker, { bigint: true });
  const sharedEntries = f.plan.entries.filter(
    (entry) => entry.kind === "file" && entry.ino === before.ino.toString(),
  );
  // Exercise copy-before-link and link-before-copy without relying on directory order.
  const fallback = sharedEntries[index]!.path;
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementation(async (existing, target) => {
    if (String(existing) === fallback) {
      throw Object.assign(new Error("hard link unavailable"), {
        code: index === 0 ? "EXDEV" : "EMLINK",
      });
    }
    return await link(existing, target);
  });
  expect(await f.link()).toEqual({ linked: 1, copied: 2 });
  const retainedWorker = path.join(f.destination, path.relative(f.source, fallback));
  const copied = await fs.stat(retainedWorker, { bigint: true });
  expect(copied.ino).not.toBe(before.ino);
  expect(Number(copied.mode & 0o777n)).toBe(0o444);
  expect(await fs.readFile(retainedWorker, "utf8")).toBe("export const generation = 'retained';\n");
});

it("refuses entries that changed after the inventory and never links a replacement", async () => {
  const f = await fixture();
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementation(async (existing, target) => {
    if (String(existing) === f.worker) {
      throw new Error("must not link a changed file");
    }
    return await link(existing, target);
  });
  fsSync.renameSync(f.worker, `${f.worker}.original`);
  fsSync.writeFileSync(f.worker, "export const generation = 'replaced';\n", { mode: 0o444 });
  await expect(f.link()).rejects.toThrow("changed after snapshot inventory");
  expect(fsSync.existsSync(path.join(f.destination, "dist", "state", "worker.js"))).toBe(false);
});

it.each(["next-entry", "copy-publication"] as const)(
  "refuses unexpected ctime changes after a prior hard link (%s)",
  async (stage) => {
    const f = await fixture();
    const before = await fs.stat(f.worker, { bigint: true });
    const sharedEntries = f.plan.entries.filter(
      (entry) => entry.kind === "file" && entry.ino === before.ino.toString(),
    );
    const later = sharedEntries[1]!.path;
    if (stage === "next-entry") {
      const lstat = fs.lstat;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        if (args[0] === later && "ctimeNs" in stat && typeof stat.ctimeNs === "bigint") {
          stat.ctimeNs += 1n;
        }
        return stat;
      });
    } else {
      const link = fs.link;
      vi.spyOn(fs, "link").mockImplementation(async (existing, target) => {
        if (existing === later) {
          throw Object.assign(new Error("hard link unavailable"), { code: "EMLINK" });
        }
        return await link(existing, target);
      });
      const lstatSync = fsSync.lstatSync;
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        const stat = lstatSync(...args);
        if (args[0] === later && stat && "ctimeNs" in stat && typeof stat.ctimeNs === "bigint") {
          stat.ctimeNs += 1n;
        }
        return stat;
      });
    }
    await expect(f.link()).rejects.toThrow("changed after snapshot inventory");
    expect(fsSync.existsSync(path.join(f.destination, path.relative(f.source, later)))).toBe(false);
  },
);
