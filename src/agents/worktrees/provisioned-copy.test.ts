import childProcess from "node:child_process";
import fsSync, { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { listDirectoryTreeStrict } from "../../infra/directory-walk.js";
import { copyProvisionedPaths } from "./provisioned-copy.js";

const { copiedOptions } = vi.hoisted(() => ({ copiedOptions: vi.fn() }));
// Observe policy at the safe-copy boundary without replacing filesystem behavior.
vi.mock("../../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/fs-safe.js")>();
  return {
    ...actual,
    root: async (...args: Parameters<typeof actual.root>) => {
      const root = await actual.root(...args);
      const copyIn = root.copyIn.bind(root);
      root.copyIn = async (...copyArgs: Parameters<typeof copyIn>) => {
        await copiedOptions(copyArgs[2]);
        return copyIn(...copyArgs);
      };
      return root;
    },
  };
});
beforeEach(() => copiedOptions.mockReset());
afterEach(() => vi.restoreAllMocks());
const directories = useAutoCleanupTempDirTracker(afterEach);

function fixture(destinationParent?: string) {
  return {
    source: directories.make("provisioned-copy-source-"),
    destination: directories.make("provisioned-copy-dest-", destinationParent),
  };
}

it.for(["native", "cross-filesystem", "portable", "revoked", "aborted"])(
  "preserves copy, skip and authority contracts with %s",
  async (blocked, context) => {
    const crossFilesystem = blocked === "cross-filesystem";
    if (crossFilesystem) {
      try {
        await fs.access("/dev/shm", fsConstants.W_OK);
        if (
          process.platform !== "linux" ||
          os.tmpdir() === "/dev/shm" ||
          (await fs.stat(os.tmpdir())).dev === (await fs.stat("/dev/shm")).dev
        ) {
          context.skip();
        }
      } catch {
        context.skip();
      }
    }
    if (blocked === "portable") {
      vi.spyOn(childProcess, "execFileSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("GNU cp unavailable"), { code: "ENOENT" });
      });
    }
    const controller = new AbortController();
    const failure = new Error("copy no longer authorized");
    if (blocked === "aborted") {
      controller.abort(failure);
    }
    const assertCurrent = () => {
      if (blocked === "revoked") {
        throw failure;
      }
    };
    const { source, destination } = fixture(crossFilesystem ? "/dev/shm" : undefined);
    const sourceFile = path.join(source, "file");
    const content = "*".repeat(64 * 1024);
    await fs.writeFile(sourceFile, content, { mode: 0o640 });
    if (crossFilesystem) {
      await expect(
        fs.copyFile(
          sourceFile,
          path.join(destination, "clone-probe"),
          fsConstants.COPYFILE_FICLONE_FORCE,
        ),
      ).rejects.toMatchObject({ code: "EXDEV" });
    }
    const modified = new Date("2020-01-02T03:04:05Z");
    await fs.utimes(sourceFile, modified, modified);
    await fs.link(sourceFile, path.join(source, "hardlink"));
    await fs.symlink("file", path.join(source, "symlink"));
    await fs.writeFile(path.join(source, "existing"), "not copied");
    await fs.writeFile(path.join(destination, "existing"), "user owned");
    await fs.mkdir(path.join(source, "nested"));
    await fs.writeFile(path.join(source, "nested", "file"), "not followed");
    await fs.symlink(source, path.join(destination, "nested"), "dir");

    const candidates = ["file", "hardlink", "symlink", "existing", "nested/file", "../escape"];
    const open = fsSync.openSync.bind(fsSync);
    vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
      if (typeof args[0] === "string" && args[0].endsWith("/existing")) {
        throw Object.assign(new Error("existing target must not require source read access"), {
          code: "EACCES",
        });
      }
      return open(...args);
    });
    const pending = copyProvisionedPaths(source, destination, candidates, {
      assertCurrent,
      signal: controller.signal,
    });
    if (blocked === "revoked" || blocked === "aborted") {
      await expect(pending).rejects.toThrow(failure);
      await expect(fs.lstat(path.join(destination, "file"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      return;
    }
    await expect(pending).resolves.toEqual(["file", "hardlink"]);
    if (copiedOptions.mock.calls.length) {
      expect(copiedOptions.mock.calls[0]?.[0]).toMatchObject({
        clone: "auto",
        overwrite: false,
        preserveSourceMode: true,
        preserveMetadata: true,
        sourceHardlinks: "allow",
        mutationSymlinks: "reject",
        durable: false,
      });
    }
    const copied = path.join(destination, "file");
    const [before, after] = await Promise.all([fs.stat(sourceFile), fs.stat(copied)]);
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readFile(copied, "utf8")).toBe(content);
    await fs.writeFile(copied, "destination only");
    expect(await fs.readFile(sourceFile, "utf8")).toBe(content);
    expect(await fs.readFile(path.join(destination, "existing"), "utf8")).toBe("user owned");
  },
);

it.skipIf(process.platform !== "linux")(
  "admits a directory once and pins source files and directories across symlink swaps",
  async () => {
    const { source, destination } = fixture();
    const outside = directories.make("provisioned-copy-outside-");
    await fs.mkdir(path.join(source, "selected"));
    await fs.mkdir(path.join(source, "skipped"));
    await fs.writeFile(path.join(outside, "file"), "outside");
    await fs.symlink(path.join(outside, "file"), path.join(source, "skipped", "link"));
    const names = Array.from({ length: 32 }, (_, index) => `selected/${index}`);
    const modified = new Map<string, bigint>();
    for (const name of names) {
      await fs.writeFile(path.join(source, name), name);
      modified.set(name, (await fs.stat(path.join(source, name), { bigint: true })).mtimeNs);
    }
    const spawn = childProcess.spawn.bind(childProcess);
    let swapped = false;
    vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
      if (!swapped) {
        swapped = true;
        fsSync.renameSync(path.join(source, "selected"), path.join(source, "admitted"));
        fsSync.symlinkSync(outside, path.join(source, "selected"), "dir");
        fsSync.renameSync(path.join(source, "admitted", "0"), path.join(source, "original"));
        fsSync.symlinkSync(path.join(outside, "file"), path.join(source, "admitted", "0"));
        fsSync.renameSync(path.join(destination, "selected"), path.join(destination, "admitted"));
        fsSync.symlinkSync(outside, path.join(destination, "selected"), "dir");
      }
      return spawn(...args);
    });
    const authority = vi.fn();
    const result = await copyProvisionedPaths(source, destination, [...names, "skipped/link"], {
      assertCurrent: authority,
    });
    expect(authority.mock.calls.length).toBeLessThanOrEqual(6);
    expect(swapped).toBe(true);
    expect(result).toEqual(names.toSorted());
    expect(await fs.readdir(outside)).toEqual(["file"]);
    await fs.unlink(path.join(destination, "selected"));
    await fs.rename(path.join(destination, "admitted"), path.join(destination, "selected"));
    expect(await fs.readdir(destination)).toEqual(["selected"]);
    for (const name of names) {
      expect(await fs.readFile(path.join(destination, name), "utf8")).toBe(name);
      expect((await fs.stat(path.join(destination, name), { bigint: true })).mtimeNs).toBe(
        modified.get(name),
      );
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "settles an accepted child before rejecting cancellation and starts no more batches",
  async () => {
    const { source, destination } = fixture();
    const names = Array.from({ length: 256 }, (_, index) => `${index}`);
    for (const name of names) {
      await fs.writeFile(path.join(source, name), name);
    }
    const controller = new AbortController();
    const failure = new Error("source retired");
    const started = Promise.withResolvers<childProcess.ChildProcessWithoutNullStreams>();
    const spawn = childProcess.spawn.bind(childProcess);
    const copies = vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      // A real child holds the native section until stdin closes, simulating blocked copy IO.
      const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: "pipe" });
      started.resolve(child);
      return child;
    });
    let settled = false;
    const pending = copyProvisionedPaths(source, destination, names, { signal: controller.signal });
    const rejection = expect(pending).rejects.toBe(failure);
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const child = await started.promise;
    controller.abort(failure);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);
    child.stdin.end();
    await rejection;
    expect(copies).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(destination)).toEqual([]);
  },
);

it.skipIf(process.platform !== "linux")(
  "rejects replacement of an admitted root before opening its descriptor",
  async () => {
    const { source, destination } = fixture();
    const retained = directories.make("provisioned-copy-retained-");
    await fs.writeFile(path.join(source, "file"), "admitted");
    const open = fs.open.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === source && !replaced) {
        replaced = true;
        await fs.rename(source, retained);
        await fs.mkdir(source);
        await fs.writeFile(path.join(source, "file"), "replacement");
      }
      return open(...args);
    });
    await expect(copyProvisionedPaths(source, destination, ["file"], {})).rejects.toThrow();
    expect(replaced).toBe(true);
    expect(await fs.readdir(destination)).toEqual([]);
  },
);

it.skipIf(process.platform !== "linux").for(["flat", "directories"])(
  "refuses publication after authority revocation during a child across %s without aborting",
  async (layout) => {
    const { source, destination } = fixture();
    const names = Array.from({ length: 256 }, (_, index) =>
      layout === "flat" ? `${index}` : `group-${Math.floor(index / 32)}/${index}`,
    );
    for (const name of names) {
      await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true });
      await fs.writeFile(path.join(source, name), name);
    }
    let current = true;
    const controller = new AbortController();
    const failure = new Error("copy authority retired");
    const spawn = childProcess.spawn.bind(childProcess);
    const copies = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
      const child = spawn(...args);
      child.once("spawn", () => {
        current = false;
      });
      return child;
    });
    await expect(
      copyProvisionedPaths(source, destination, names, {
        signal: controller.signal,
        assertCurrent() {
          if (!current) {
            throw failure;
          }
        },
      }),
    ).rejects.toBe(failure);
    expect(copies).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(false);
    const remaining = await listDirectoryTreeStrict(destination);
    expect(
      remaining.every(
        ({ dirent }) => dirent.isDirectory() && !dirent.name.startsWith(".provision-"),
      ),
    ).toBe(true);
  },
);

it("rejects an included file replaced by a symlink during portable copy inspection", async () => {
  vi.spyOn(childProcess, "execFileSync").mockImplementationOnce(() => {
    throw Object.assign(new Error("GNU cp unavailable"), { code: "ENOENT" });
  });
  const { source: repo, destination } = fixture();
  const source = path.join(repo, "settings.local");
  await fs.writeFile(source, "included bytes\n");
  const outside = path.join(directories.make("provisioned-copy-outside-"), "outside.txt");
  await fs.writeFile(outside, "outside bytes\n");
  const lstat = fs.lstat.bind(fs);
  let replaced = false;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    const observed = await lstat(...args);
    if (args[0] === source && !replaced) {
      replaced = true;
      await fs.rename(source, `${source}.original`);
      await fs.symlink(outside, source);
    }
    return observed;
  });

  await expect(copyProvisionedPaths(repo, destination, ["settings.local"], {})).rejects.toThrow();

  expect(replaced).toBe(true);
  expect(await fs.readdir(destination)).toEqual([]);
  expect(await fs.readFile(outside, "utf8")).toBe("outside bytes\n");
});

it.skipIf(process.platform !== "linux").for(["abort", "authority"])(
  "refuses a child when %s is revoked during staging preparation",
  async (kind) => {
    const { source, destination } = fixture();
    await fs.writeFile(path.join(source, "file"), "admitted");
    const failure = new Error("staging authority retired");
    const controller = new AbortController();
    let current = true;
    const mkdtemp = fs.mkdtemp.bind(fs);
    vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
      const stage = await mkdtemp(...args);
      current = false;
      if (kind === "abort") {
        controller.abort(failure);
      }
      return stage;
    });
    const copies = vi.spyOn(childProcess, "spawn");
    await expect(
      copyProvisionedPaths(source, destination, ["file"], {
        signal: controller.signal,
        assertCurrent() {
          if (!current) {
            throw failure;
          }
        },
      }),
    ).rejects.toBe(failure);
    expect(copies).not.toHaveBeenCalled();
    expect(await fs.readdir(destination)).toEqual([]);
  },
);
