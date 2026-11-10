import childProcess from "node:child_process";
import fsSync, { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { hasErrnoCode } from "../../infra/errno.js";
import type { Root } from "../../infra/fs-safe.js";
import { normalizeProvisionedRelativePath } from "./provisioned-file-inspection.js";

type Selection = { files: Set<string>; directories: Map<string, Selection> };
const selection = (): Selection => ({ files: new Set(), directories: new Map() });
const descriptorPath = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;
const isAbsentOrSymlink = (error: unknown) =>
  hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR") || hasErrnoCode(error, "ELOOP");

async function openDirectory(target: string): Promise<FileHandle | undefined> {
  try {
    return await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (!isAbsentOrSymlink(error)) {
      throw error;
    }
    return undefined;
  }
}

/** The unpublished destination is owned by preparation; source names may change at any time. */
export async function copyProvisionedPathsLinux(
  sourceRoot: Root,
  destinationRoot: Root,
  paths: readonly string[],
  options: {
    signal?: AbortSignal;
    assertCurrent?: () => void;
  },
): Promise<string[] | undefined> {
  if (process.platform !== "linux") {
    return undefined;
  }
  // Linux without procfs or GNU cp retains the portable guarded copier.
  try {
    await fs.access("/proc/self/fd");
    if (
      !childProcess
        .execFileSync("cp", ["--version"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
        .startsWith("cp (GNU coreutils)")
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const tree = selection();
  for (const candidate of paths) {
    const relative = normalizeProvisionedRelativePath(candidate);
    if (!relative) {
      continue;
    }
    const segments = relative.split("/");
    const name = segments.pop()!;
    let node = tree;
    for (const segment of segments) {
      let child = node.directories.get(segment);
      if (!child) {
        child = selection();
        node.directories.set(segment, child);
      }
      node = child;
    }
    node.files.add(name);
  }
  const openRoot = async (root: Root) => {
    const handle = await openDirectory(root.rootReal);
    if (!handle) {
      throw new Error("Provisioning root changed");
    }
    try {
      const [opened, admitted] = await Promise.all([handle.stat({ bigint: true }), root.stat(".")]);
      if (
        opened.dev !== admitted.exactIdentity?.dev ||
        opened.ino !== admitted.exactIdentity?.ino
      ) {
        throw new Error("Provisioning root changed");
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  };
  await using sourceRootHandle = await openRoot(sourceRoot);
  await using destinationRootHandle = await openRoot(destinationRoot);
  const copied: string[] = [];
  const batch: { path: string; target: string; fd: number; mode: number }[] = [];
  const destinations = new Map<string, number>();
  let admitted = 0;
  const check = () => options.signal?.throwIfAborted();
  const releaseBatch = () => {
    for (const file of batch) {
      fsSync.closeSync(file.fd);
    }
    batch.length = 0;
    for (const fd of destinations.values()) {
      fsSync.closeSync(fd);
    }
    destinations.clear();
  };
  const flush = async () => {
    if (!batch.length) {
      return;
    }
    let stage: string | undefined;
    try {
      check();
      stage = await fs.mkdtemp(`${descriptorPath(destinationRootHandle)}/.provision-`);
      await using staging = await fs.open(
        stage,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      // Inherited descriptors pin every input. Native cp retains nanosecond timestamps
      // and reflinks; one bounded batch can span many small selected directories.
      await new Promise<void>((resolve, reject) => {
        const child = childProcess.spawn(
          "cp",
          [
            "-L",
            "--reflink=auto",
            "--preserve=timestamps",
            "-t",
            "/proc/self/fd/3",
            ...batch.map((_, index) => `/proc/self/fd/${index + 4}`),
          ],
          {
            stdio: ["ignore", "ignore", "pipe", staging.fd, ...batch.map((file) => file.fd)],
          },
        );
        let failure: Error | undefined;
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(0, 8192);
        });
        child.once("error", (error) => {
          failure = error;
        });
        // Cancellation stops admission, but custody includes child close and cleanup.
        child.once("close", (code) =>
          code === 0
            ? resolve()
            : reject(failure ?? new Error(`Provisioning copy failed (${code}): ${stderr}`)),
        );
      });
      check();
      for (const [index, file] of batch.entries()) {
        const staged = `${descriptorPath(staging)}/${index + 4}`;
        fsSync.chmodSync(staged, file.mode);
        try {
          fsSync.linkSync(staged, file.target);
        } catch (error) {
          if (hasErrnoCode(error, "EEXIST")) {
            continue;
          }
          throw error;
        }
        copied.push(file.path);
      }
    } finally {
      releaseBatch();
      if (stage) {
        fsSync.rmSync(stage, { recursive: true, force: true });
      }
    }
    check();
    options.assertCurrent?.();
    check();
  };
  const visit = async (
    source: FileHandle,
    destination: FileHandle,
    node: Selection,
    prefix: string,
  ): Promise<void> => {
    check();
    options.assertCurrent?.();
    check();
    for (const name of node.files) {
      if (fsSync.lstatSync(`${descriptorPath(destination)}/${name}`, { throwIfNoEntry: false })) {
        continue;
      }
      let fd: number;
      try {
        fd = fsSync.openSync(
          `${descriptorPath(source)}/${name}`,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (error) {
        if (isAbsentOrSymlink(error)) {
          continue;
        }
        throw error;
      }
      let retained = false;
      try {
        const stat = fsSync.fstatSync(fd);
        if (stat.isFile()) {
          let target = destinations.get(prefix);
          if (target === undefined) {
            // Pending files outlive this recursive directory visit; pin its admitted parent.
            target = fsSync.openSync(
              `${descriptorPath(destination)}/.`,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            destinations.set(prefix, target);
          }
          batch.push({
            path: prefix + name,
            target: `/proc/self/fd/${target}/${name}`,
            fd,
            mode: stat.mode & 0o7777,
          });
          retained = true;
          admitted++;
        }
      } finally {
        if (!retained) {
          fsSync.closeSync(fd);
        }
      }
      if (batch.length === 128) {
        await flush();
      }
    }
    for (const [name, child] of node.directories) {
      check();
      await using sourceChild = await openDirectory(`${descriptorPath(source)}/${name}`);
      if (!sourceChild) {
        continue;
      }
      const target = `${descriptorPath(destination)}/${name}`;
      let created = true;
      await fs.mkdir(target).catch((error: unknown) => {
        if (!hasErrnoCode(error, "EEXIST")) {
          throw error;
        }
        created = false;
      });
      await using destinationChild = await openDirectory(target);
      const before = admitted;
      if (destinationChild) {
        await visit(sourceChild, destinationChild, child, `${prefix}${name}/`);
      }
      if (created && admitted === before) {
        await fs.rmdir(target);
      }
    }
  };
  try {
    await visit(sourceRootHandle, destinationRootHandle, tree, "");
    await flush();
    return copied.toSorted();
  } finally {
    releaseBatch();
  }
}
