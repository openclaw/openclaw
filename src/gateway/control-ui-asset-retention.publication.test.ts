import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createControlUiAssetRetention } from "./control-ui-asset-retention.js";
import {
  withRetentionFixture,
  writeRetentionBuild,
} from "./control-ui-asset-retention.test-support.js";

const pruneLogs = vi.hoisted(() => ({ debug: vi.fn(), warn: vi.fn() }));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => pruneLogs }));

describe("Control UI retained publication", () => {
  it.each(["removed", "replaced-valid", "symlink"] as const)(
    "rechecks a %s current target before refreshing it",
    async (mutation) => {
      await withRetentionFixture(async ({ root, cache, seed }) => {
        const current = await seed("current");
        const sibling = await seed("sibling");
        const outside = path.join(root, "outside");
        await fs.cp(current.root, outside, { recursive: true });
        await fs.utimes(outside, 1_700_000_100, 1_700_000_100);
        const outsideBefore = await fs.stat(outside);
        const contents = await fs.readFile(path.join(current.root, current.assetPath));
        const targetAsset = path.join(current.target, current.assetPath);
        const siblingAsset = path.join(sibling.target, sibling.assetPath);
        const opens = new Map([
          [targetAsset, 0],
          [siblingAsset, 0],
        ]);
        const refreshOpens: number[] = [];
        const readFile = fs.readFile;
        const open = fs.open;
        const utimes = fs.utimes;
        let mutated = false;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const file = args[0];
          if (typeof file === "string" && opens.has(file)) {
            opens.set(file, opens.get(file)! + 1);
          }
          return open(...args);
        });
        vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
          const result = await readFile(...args);
          const file = args[0];
          if (!mutated && file === path.join(current.root, "asset-manifest.json")) {
            mutated = true;
            if (mutation === "removed") {
              await fs.rm(current.target, { recursive: true });
            } else {
              await fs.rename(current.target, path.join(root, "displaced"));
              if (mutation === "replaced-valid") {
                await fs.cp(current.root, current.target, { recursive: true });
              } else {
                await fs.symlink(outside, current.target, "dir");
              }
            }
          }
          return result;
        });
        vi.spyOn(fs, "utimes").mockImplementation(async (...args) => {
          if (args[0] === current.target) {
            refreshOpens.push(opens.get(targetAsset)!);
          }
          return utimes(...args);
        });
        const owner = createControlUiAssetRetention(current.root);
        if (mutation === "symlink") {
          await expect(owner.prepare()).rejects.toThrow();
          expect(refreshOpens).toEqual([]);
        } else {
          await owner.prepare();
          expect(owner.resolveAsset(current.assetPath)?.filePath).toBe(targetAsset);
          expect(refreshOpens).toEqual([2]);
          expect(opens.get(targetAsset)).toBe(2);
        }
        expect(mutated).toBe(true);
        expect(opens.get(siblingAsset)).toBe(1);
        vi.restoreAllMocks();
        expect(await fs.readFile(targetAsset)).toEqual(contents);
        expect(await fs.readFile(path.join(outside, current.assetPath))).toEqual(contents);
        expect((await fs.stat(outside)).mtimeMs).toBe(outsideBefore.mtimeMs);
        expect((await fs.readdir(cache)).toSorted()).toEqual(
          [current.manifest.generation, sibling.manifest.generation].toSorted(),
        );
      });
    },
  );

  it.each(["claim", "cleanup"] as const)(
    "warns when pruning %s fails after publication",
    async (step) => {
      await withRetentionFixture(async ({ root, cache, seed }) => {
        pruneLogs.warn.mockClear();
        const history = [await seed("a"), await seed("b"), await seed("c")].toSorted((a, b) =>
          a.manifest.generation.localeCompare(b.manifest.generation),
        );
        const victim = history[2]!.target;
        const build = await writeRetentionBuild(path.join(root, "current"), "current");
        const failure = Object.assign(new Error(`prune ${step} denied`), { code: "EPERM" });
        const rename = fs.rename;
        const rm = fs.rm;
        let claimed: string | undefined;
        vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (args[0] === victim) {
            if (step === "claim") {
              throw failure;
            }
            claimed = path.dirname(String(args[1]));
          }
          return rename(...args);
        });
        vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
          if (args[0] === claimed) {
            throw failure;
          }
          return rm(...args);
        });
        const owner = createControlUiAssetRetention(build.root);
        await expect(owner.prepare()).resolves.toBeUndefined();
        expect(pruneLogs.warn).toHaveBeenCalledWith(expect.any(String), {
          directory: victim,
          outcome: "deferred",
          error: String(failure),
        });
        expect(await fs.readFile(owner.resolveAsset(build.assetPath)!.filePath)).toEqual(
          await fs.readFile(path.join(build.root, build.assetPath)),
        );
        const retainedVictim = claimed ? path.join(claimed, path.basename(victim)) : victim;
        expect(await fs.readFile(path.join(retainedVictim, history[2]!.assetPath))).toEqual(
          await fs.readFile(path.join(history[2]!.root, history[2]!.assetPath)),
        );
        expect(
          (await fs.readdir(cache)).filter((name) => name.startsWith(".staging-")),
        ).toHaveLength(step === "cleanup" ? 1 : 0);
      });
    },
  );

  it.each(["native", "EPERM", "ENOTEMPTY"] as const)(
    "records concurrent different-target pruning with %s deletion",
    async (fault) => {
      for (let iteration = 0; iteration < (fault === "native" ? 3 : 1); iteration++) {
        await withRetentionFixture(async ({ root, cache, seed }) => {
          pruneLogs.debug.mockClear();
          pruneLogs.warn.mockClear();
          const old = [await seed("old-a"), await seed("old-b")].toSorted((a, b) =>
            a.manifest.generation.localeCompare(b.manifest.generation),
          );
          const victim = old[1]!.target;
          const builds = [
            await writeRetentionBuild(path.join(root, "a"), "a"),
            await writeRetentionBuild(path.join(root, "b"), "b"),
          ];
          const owners = builds.map((build) => createControlUiAssetRetention(build.root));
          const publications = createDeferred();
          const pruners = createDeferred();
          const firstPruner = createDeferred();
          const loser = createDeferred();
          let published = 0;
          let pruning = 0;
          const missing: unknown[] = [];
          const rename = fs.rename;
          const rm = fs.rm;
          const collision = Object.assign(new Error("concurrent deletion"), { code: fault });
          const prune = async (operation: () => Promise<void>, claim: boolean) => {
            const arrival = ++pruning;
            if (arrival === 2) {
              pruners.resolve();
            }
            await pruners.promise;
            if (arrival === 1) {
              try {
                if (claim || fault === "native") {
                  await operation();
                } else {
                  // Before the fix, both publishers remove the same live tree.
                  await fs.unlink(path.join(victim, "asset-manifest.json"));
                }
                firstPruner.resolve();
                await loser.promise;
                if (!claim && fault !== "native") {
                  await operation();
                }
              } finally {
                firstPruner.resolve();
              }
            } else {
              await firstPruner.promise;
              try {
                if (fault !== "native") {
                  throw collision;
                }
                await fs.lstat(victim).catch((error: unknown) => {
                  missing.push(error);
                });
                await operation();
              } finally {
                loser.resolve();
              }
            }
          };
          vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
            if (args[0] === victim) {
              return prune(() => rename(...args), true);
            }
            await rename(...args);
            if (++published === 2) {
              publications.resolve();
            }
            await publications.promise;
          });
          vi.spyOn(fs, "rm").mockImplementation(async (...args) =>
            args[0] === victim ? prune(() => rm(...args), false) : rm(...args),
          );
          const results = await Promise.allSettled(owners.map((owner) => owner.prepare()));
          expect(results).toEqual([
            { status: "fulfilled", value: undefined },
            { status: "fulfilled", value: undefined },
          ]);
          expect(pruning).toBe(2);
          expect(missing).toMatchObject(fault === "native" ? [{ code: "ENOENT" }] : []);
          expect(pruneLogs.debug).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ directory: victim, outcome: "already-pruned" }),
          );
          expect(pruneLogs.warn).not.toHaveBeenCalled();
          for (const [index, build] of builds.entries()) {
            expect(
              await fs.readFile(owners[index]!.resolveAsset(build.assetPath)!.filePath),
            ).toEqual(await fs.readFile(path.join(build.root, build.assetPath)));
          }
          expect(await fs.readdir(cache)).toHaveLength(3);
        });
      }
    },
  );

  it.each(["same", "different"] as const)(
    "coordinates native concurrent %s-target publication without losing the winner",
    async (kind) => {
      await withRetentionFixture(async ({ root, cache, seed }) => {
        const old = [await seed("old-a"), await seed("old-b")];
        const a = await writeRetentionBuild(path.join(root, "a"), "a");
        const b = kind === "same" ? a : await writeRetentionBuild(path.join(root, "b"), "b");
        const owners = [
          createControlUiAssetRetention(a.root),
          createControlUiAssetRetention(b.root),
        ];
        const barrier = createDeferred();
        let arrivals = 0;
        const rename = fs.rename;
        const errors: string[] = [];
        vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (!path.basename(String(args[0])).startsWith(".staging-")) {
            return rename(...args);
          }
          // Both preparers reach real rename from their own completed staging tree.
          if (++arrivals === 2) {
            barrier.resolve();
          }
          await barrier.promise;
          try {
            await rename(...args);
          } catch (error) {
            errors.push((error as NodeJS.ErrnoException).code!);
            throw error;
          }
        });
        const results = await Promise.allSettled(owners.map((owner) => owner.prepare()));
        expect(results).toEqual([
          { status: "fulfilled", value: undefined },
          { status: "fulfilled", value: undefined },
        ]);
        expect(arrivals).toBe(2);
        if (kind === "same") {
          expect(errors).toHaveLength(1);
          expect(
            process.platform === "win32"
              ? ["EEXIST", "ENOTEMPTY", "EPERM"]
              : ["EEXIST", "ENOTEMPTY"],
          ).toContain(errors[0]);
        } else {
          expect(errors).toEqual([]);
        }
        for (const [index, owner] of owners.entries()) {
          const build = index === 0 ? a : b;
          expect(
            await fs.readFile(owner.resolveAsset(build.assetPath)!.filePath, "utf8"),
          ).toContain(index === 0 || kind === "same" ? '"a"' : '"b"');
        }
        const entries = await fs.readdir(cache);
        expect(entries).toHaveLength(3);
        expect(entries.some((entry) => entry.startsWith(".staging-"))).toBe(false);
        if (kind === "different") {
          expect(entries).toContain(a.manifest.generation);
          expect(entries).toContain(b.manifest.generation);
          expect(old.filter((build) => entries.includes(build.manifest.generation))).toHaveLength(
            1,
          );
        }
      });
    },
  );

  it.each(["partial", "zero-progress"] as const)(
    "handles %s destination writes without adopting incomplete bytes",
    async (behavior) => {
      await withRetentionFixture(async ({ root, cache }) => {
        const build = await writeRetentionBuild(path.join(root, "build"), "write", {
          size: 128 * 1024,
        });
        const source = path.join(build.root, build.assetPath);
        const open = fs.open;
        let intercepted = false;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          const file = args[0];
          if (
            typeof file !== "string" ||
            !file.includes(".staging-") ||
            !file.endsWith(`${path.sep}${path.normalize(build.assetPath)}`)
          ) {
            return handle;
          }
          const write = handle.write.bind(handle);
          vi.spyOn(handle, "write").mockImplementation((async (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number | null,
          ) => {
            intercepted = true;
            if (behavior === "zero-progress") {
              return { buffer, bytesWritten: 0 };
            }
            return await write(buffer, offset, Math.min(length, 17), position);
          }) as typeof handle.write);
          return handle;
        });
        const owner = createControlUiAssetRetention(build.root);
        if (behavior === "zero-progress") {
          await expect(owner.prepare()).rejects.toThrow("write made no progress");
          expect(owner.resolveAsset(build.assetPath)).toBeNull();
          expect(await fs.readdir(cache)).toEqual([]);
        } else {
          await owner.prepare();
          expect(await fs.readFile(owner.resolveAsset(build.assetPath)!.filePath)).toEqual(
            await fs.readFile(source),
          );
        }
        expect(intercepted).toBe(true);
        expect((await fs.readdir(cache)).some((entry) => entry.startsWith(".staging-"))).toBe(
          false,
        );
      });
    },
  );

  it.each([
    ["EEXIST", "valid"],
    ["ENOTEMPTY", "valid"],
    ["EEXIST", "digest"],
    ["ENOTEMPTY", "digest"],
    ["EEXIST", "manifest"],
    ["ENOTEMPTY", "manifest"],
    ["EEXIST", "symlink"],
    ["ENOTEMPTY", "symlink"],
    ["EPERM", "valid"],
    ["EPERM", "digest"],
    ["EPERM", "manifest"],
    ["EPERM", "symlink"],
    ["EACCES", "valid"],
  ] as const)("handles %s only when its exact winner is %s", async (code, integrity) => {
    await withRetentionFixture(async ({ root, cache }) => {
      const build = await writeRetentionBuild(path.join(root, "build"), "winner");
      const target = path.join(cache, build.manifest.generation);
      const collision = Object.assign(new Error("rename failed"), { code });
      vi.spyOn(fs, "rename").mockImplementation(async () => {
        if (integrity === "symlink") {
          await fs.symlink(build.root, target, "dir");
        } else {
          await fs.cp(build.root, target, { recursive: true });
          if (integrity === "digest") {
            await fs.writeFile(
              path.join(target, build.assetPath),
              Buffer.alloc(build.manifest.assets[0]!.size, 120),
            );
          }
          if (integrity === "manifest") {
            await fs.writeFile(path.join(target, "asset-manifest.json"), "{");
          }
        }
        throw collision;
      });
      const owner = createControlUiAssetRetention(build.root);
      if (
        integrity === "valid" &&
        code !== "EACCES" &&
        (code !== "EPERM" || process.platform === "win32")
      ) {
        await owner.prepare();
        expect(owner.resolveAsset(build.assetPath)?.filePath).toBe(
          path.join(target, build.assetPath),
        );
      } else {
        await expect(owner.prepare()).rejects.toBe(collision);
        expect(owner.resolveAsset(build.assetPath)).toBeNull();
      }
      // A failed loser owns its staging only, including when the winner is invalid.
      expect(await fs.readdir(cache)).toEqual([build.manifest.generation]);
    });
  });

  it("verifies its newly published target before adopting it", async () => {
    await withRetentionFixture(async ({ root, cache }) => {
      const build = await writeRetentionBuild(path.join(root, "build"), "new");
      const rename = fs.rename;
      vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        await rename(...args);
        await fs.writeFile(
          path.join(cache, build.manifest.generation, build.assetPath),
          Buffer.alloc(build.manifest.assets[0]!.size, 120),
        );
      });
      const owner = createControlUiAssetRetention(build.root);
      await expect(owner.prepare()).rejects.toThrow("Invalid retained Control UI generation");
      expect(owner.resolveAsset(build.assetPath)).toBeNull();
      expect(await fs.readdir(cache)).toEqual([build.manifest.generation]);
    });
  });

  it("revalidates a replaced directory instead of trusting an old verified record", async () => {
    await withRetentionFixture(async ({ root, seed }) => {
      const old = await seed("old");
      const build = await writeRetentionBuild(path.join(root, "build"), "new");
      const readFile = fs.readFile;
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        const result = await readFile(...args);
        if (args[0] === path.join(build.root, "asset-manifest.json")) {
          await fs.rename(old.target, path.join(root, "previous-inode"));
          await fs.cp(old.root, old.target, { recursive: true });
          await fs.writeFile(
            path.join(old.target, old.assetPath),
            Buffer.alloc(old.manifest.assets[0]!.size, 120),
          );
        }
        return result;
      });
      const owner = createControlUiAssetRetention(build.root);
      await owner.prepare();
      expect(owner.resolveAsset(old.assetPath)).toBeNull();
      expect(owner.resolveAsset(build.assetPath)).not.toBeNull();
      await expect(fs.access(old.target)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.each(["replace-evicted", "remove-survivor"] as const)(
    "respects a concurrent %s after its pruning inventory",
    async (mutation) => {
      await withRetentionFixture(async ({ root, cache, seed }) => {
        const current = await seed("current");
        const history = [await seed("a"), await seed("b"), await seed("c")].toSorted((a, b) =>
          a.manifest.generation.localeCompare(b.manifest.generation),
        );
        const victim = mutation === "replace-evicted" ? history[2]! : history[0]!;
        const stale = path.join(cache, ".staging-1-aaaa");
        await fs.mkdir(stale);
        await fs.utimes(stale, 0, 0);
        const rename = fs.rename;
        let raced = false;
        vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          await rename(...args);
          if (args[0] === stale) {
            raced = true;
            await rename(victim.target, path.join(root, "concurrently-removed"));
            if (mutation === "replace-evicted") {
              await fs.cp(victim.root, victim.target, { recursive: true });
            }
          }
        });
        const owner = createControlUiAssetRetention(current.root);
        await owner.prepare();
        expect(raced).toBe(true);
        expect(owner.resolveAsset(victim.assetPath)).toBeNull();
        expect(owner.resolveAsset(current.assetPath)).not.toBeNull();
        expect(
          await fs.access(victim.target).then(
            () => true,
            () => false,
          ),
        ).toBe(mutation === "replace-evicted");
      });
    },
  );
});
