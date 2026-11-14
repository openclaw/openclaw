import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { repository } from "../../infra/git-worker-lifecycle.test-support.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { inspectNestedRepository } from "./snapshot-inventory.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await drainGlobalSingletonLifecycleState();
  vi.restoreAllMocks();
});

it.skipIf(process.platform === "win32").each(["entries", "ENOENT", "ENAMETOOLONG"] as const)(
  "preserves raw directory bytes alongside typed UTF-8 siblings: %s",
  async (listing) => {
    const repo = await repository(tempDirs.make("openclaw-mixed-directory-bytes-"));
    await fs.writeFile(path.join(repo, ".gitignore"), "a-fast/\nz-raw/\n");
    const fast = path.join(repo, "a-fast");
    const raw = path.join(repo, "z-raw");
    const physical = path.join(raw, "x");
    const virtual = Buffer.concat([Buffer.from(`${raw}/`), Buffer.from([0xff])]);
    await fs.mkdir(path.join(fast, "unknown"), { recursive: true });
    await fs.mkdir(physical, { recursive: true });
    const knownFile = path.join(fast, "known.txt");
    await fs.writeFile(knownFile, "typed file\n");
    // APFS cannot create invalid UTF-8 names; virtualize only that directory's
    // filesystem bytes. The sibling and all metadata still use real files.
    const physicalPath = (target: Parameters<typeof fs.lstat>[0]) =>
      Buffer.isBuffer(target) && target.subarray(0, virtual.length).equals(virtual)
        ? Buffer.concat([Buffer.from(physical), target.subarray(virtual.length)])
        : target;
    const readdir = fs.readdir;
    vi.spyOn(fs, "readdir").mockImplementation(async (target, options) => {
      if (String(target) === raw && options.withFileTypes && listing !== "entries") {
        throw Object.assign(new Error("unrepresentable directory entry"), { code: listing });
      }
      const entries = await readdir(physicalPath(target), { ...options, recursive: false });
      if (String(target) === raw) {
        if (options.withFileTypes) {
          Object.defineProperty(entries[0], "name", { value: "\uFFFD" });
        } else {
          Reflect.set(entries[0]!, 0, 0xff);
        }
      }
      if (String(target) === fast && options.withFileTypes) {
        for (const entry of entries) {
          if (String(entry.name) === "unknown") {
            Object.assign(entry, {
              isFile: () => false,
              isDirectory: () => false,
              isSymbolicLink: () => false,
            });
          }
        }
      }
      return entries;
    });
    const lstat = fs.lstat;
    const observed: string[] = [];
    vi.spyOn(fs, "lstat").mockImplementation((target, ...args) => {
      observed.push(
        (Buffer.isBuffer(target) ? target : Buffer.from(String(target))).toString("hex"),
      );
      return lstat(physicalPath(target), ...args);
    });
    const inspect = () => inspectNestedRepository(repo);
    expect(await inspect()).toBe(false);
    expect(observed).toContain(virtual.toString("hex"));
    expect(observed).toContain(Buffer.from(path.join(fast, "unknown")).toString("hex"));
    expect(observed).not.toContain(Buffer.from(knownFile).toString("hex"));
    await fs.symlink("missing-git-metadata", path.join(physical, ".git"));
    expect(await inspect()).toBe(true);
  },
);
