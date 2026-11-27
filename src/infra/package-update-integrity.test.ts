import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { interceptPackageFileHashes } from "./package-update-integrity-hasher.test-support.js";
import {
  createPackageIntegrityReader,
  PackageIntegrityTimeoutError,
} from "./package-update-integrity.js";

afterEach(() => vi.restoreAllMocks());

const SETTLED_TIME = new Date(1_700_000_000_000);
// A substitution also changes its parent directory, and a new directory can
// reuse the inode. Sweep reads run in batches, so either entry may refuse
// first; both are strict stat refusals, not a re-read of contents.
const SUBSTITUTION_REFUSAL = /entry="dist(?:\/entry\.js)?"; changes=\{[^;]*\} Drift:/u;

async function writeDriftPackage(root: string) {
  await fs.writeFile(path.join(root, "package.json"), '{"version":"1.0.0"}');
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "dist", "entry.js"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "dist", "other.js"), "export {};\n");
  // Whole-millisecond times can be restored exactly through utimes.
  for (const entry of ["dist/entry.js", "dist"]) {
    await fs.utimes(path.join(root, entry), SETTLED_TIME, SETTLED_TIME);
  }
}

/** Run `action` when the final sweep observes `target`, after its bytes were hashed. */
function atFinalSweep(target: string, action: () => Promise<void>) {
  const lstat = fs.lstat.bind(fs);
  let observations = 0;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    if (String(args[0]) === target && ++observations === 2) {
      await action();
    }
    return lstat(...args);
  });
}

async function scan(root: string) {
  const warnings: string[] = [];
  const result = await createPackageIntegrityReader(undefined, { warnings }).rootEntry(root);
  if (result.kind !== "directory") {
    throw new Error("expected a package directory");
  }
  return { tree: result.tree, warnings };
}

describe.runIf(process.platform !== "win32")("metadata-only drift during a package scan", () => {
  it.each([
    {
      shape: "same-mode chmod",
      entry: "dist/entry.js",
      act: async (file: string) => fs.chmod(file, (await fs.stat(file)).mode & 0o7777),
      fields: '"ctimeNs"',
    },
    {
      shape: "extra hard link",
      entry: "dist/entry.js",
      act: (file: string) => fs.link(file, `${path.dirname(path.dirname(file))}.link`),
      fields: '"nlink"',
    },
    {
      shape: "same-mode directory chmod",
      entry: "dist",
      act: async (file: string) => fs.chmod(file, (await fs.stat(file)).mode & 0o7777),
      fields: '"ctimeNs"',
    },
  ])("accepts $shape after confirming the entry and reports it", async ({ entry, act, fields }) => {
    await withTestDir({ prefix: "package-integrity-drift-" }, async (base) => {
      const root = path.join(base, "openclaw");
      await fs.mkdir(root);
      await writeDriftPackage(root);
      const clean = await scan(root);
      expect(clean.warnings).toEqual([]);
      const target = path.join(root, entry);
      atFinalSweep(target, () => act(target));
      const drifted = await scan(root);
      expect(drifted.tree).toEqual(clean.tree);
      expect(drifted.warnings).toHaveLength(1);
      const [warning] = drifted.warnings;
      expect(warning).toContain("on 1 entry whose contents, size, type and mode are unchanged");
      expect(warning).toContain(`entry=${JSON.stringify(entry)}`);
      expect(warning).toContain(fields);
    });
  });

  it("accepts metadata drift that lands while the file is being hashed", async () => {
    await withTestDir({ prefix: "package-integrity-drift-read-" }, async (root) => {
      await writeDriftPackage(root);
      const clean = await scan(root);
      const target = path.join(root, "dist", "entry.js");
      interceptPackageFileHashes(async (file, _stat, next) => {
        if (file === target) {
          await fs.chmod(file, (await fs.stat(file)).mode & 0o7777);
        }
        return next();
      });
      const drifted = await scan(root);
      expect(drifted.tree).toEqual(clean.tree);
      expect(drifted.warnings).toEqual([expect.stringContaining('entry="dist/entry.js"')]);
    });
  });

  it.each([
    {
      shape: "same-size content with its mtime restored",
      act: async (file: string) => {
        await fs.writeFile(file, "export const value = 2;\n");
        await fs.utimes(file, SETTLED_TIME, SETTLED_TIME);
      },
      refusal: /entry="dist\/entry\.js"; changes=\{"ctimeNs".*\}; contents changed/u,
    },
    {
      shape: "executable bit",
      act: (file: string) => fs.chmod(file, 0o755),
      refusal: /entry="dist\/entry\.js"; changes=\{"mode"/u,
    },
    {
      shape: "symlink substitution",
      act: async (file: string) => {
        await fs.rename(file, `${file}.moved`);
        await fs.symlink("other.js", file);
      },
      refusal: SUBSTITUTION_REFUSAL,
    },
    {
      shape: "directory substitution",
      act: async (file: string) => {
        await fs.rm(file);
        await fs.mkdir(file);
      },
      refusal: SUBSTITUTION_REFUSAL,
    },
    {
      shape: "removed entry",
      act: (file: string) => fs.rm(file),
      refusal: /ENOENT/u,
    },
  ])("refuses $shape at the final sweep", async ({ act, refusal }) => {
    await withTestDir({ prefix: "package-integrity-drift-refused-" }, async (root) => {
      await writeDriftPackage(root);
      const target = path.join(root, "dist", "entry.js");
      atFinalSweep(target, () => act(target));
      await expect(scan(root)).rejects.toThrow(refusal);
    });
  });

  it("refuses an entry added to a directory whose times were restored", async () => {
    await withTestDir({ prefix: "package-integrity-drift-added-" }, async (root) => {
      await writeDriftPackage(root);
      const directory = path.join(root, "dist");
      atFinalSweep(directory, async () => {
        await fs.writeFile(path.join(directory, "added.js"), "export {};\n");
        await fs.utimes(directory, SETTLED_TIME, SETTLED_TIME);
      });
      // Linux reports this as children changed; APFS also moves the directory size.
      await expect(scan(root)).rejects.toThrow(/entry="dist"; changes=\{.*\}/u);
    });
  });
});

it("verifies a wide package within the deadline on slow storage", async () => {
  await withTestDir({ prefix: "package-integrity-sweep-" }, async (root) => {
    await fs.writeFile(path.join(root, "package.json"), '{"version":"1.0.0"}');
    for (let index = 0; index < 64; index++) {
      await fs.writeFile(path.join(root, `entry-${index}`), "");
    }
    let now = 0;
    let rounds = 0;
    let scheduled: Promise<void> | undefined;
    const observed = new Map<string, Awaited<ReturnType<typeof fs.lstat>>>();
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const file = String(args[0]);
      const previous = observed.get(file);
      // rootEntry observes the root once before the tree walk.
      if (previous && file !== root) {
        // All reads admitted in one turn share one simulated storage round trip.
        scheduled ??= setImmediate().then(() => {
          now += 10;
          rounds++;
          scheduled = undefined;
        });
        await scheduled;
        return previous;
      }
      const stat = await lstat(...args);
      observed.set(file, stat);
      return stat;
    });
    const result = await createPackageIntegrityReader(100).rootEntry(root);
    expect(result).toMatchObject({ kind: "directory", tree: { version: "1.0.0" } });
    expect(rounds).toBeLessThan(10);
  });
});

it("preserves earlier drift evidence when a later sweep read times out first", async () => {
  await withTestDir({ prefix: "package-integrity-sweep-order-" }, async (root) => {
    await fs.writeFile(path.join(root, "package.json"), '{"version":"1.0.0"}');
    const first = path.join(root, "a");
    const second = path.join(root, "b");
    await fs.writeFile(first, "");
    await fs.writeFile(second, "");
    const seen = new Set<string>();
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const file = String(args[0]);
      if (seen.has(file)) {
        if (file === first) {
          await setImmediate();
          await fs.writeFile(first, "changed");
        } else if (file === second) {
          throw new PackageIntegrityTimeoutError(1_000);
        }
      }
      seen.add(file);
      return lstat(...args);
    });
    await expect(createPackageIntegrityReader().rootEntry(root)).rejects.toThrow(
      "Package rollback tree changed during verification",
    );
  });
});
