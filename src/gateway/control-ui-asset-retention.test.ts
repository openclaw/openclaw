import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { CONTROL_UI_ASSET_MANIFEST_FILENAME } from "./control-ui-asset-manifest.js";
import { createControlUiAssetRetention } from "./control-ui-asset-retention.js";
import {
  createRetentionManifest,
  withRetentionFixture,
  writeRetentionBuild,
} from "./control-ui-asset-retention.test-support.js";

describe("Control UI asset retention", () => {
  it("verifies each retained asset once without whole-file reads", async () => {
    const fixture = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-retention-io-")),
    );
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(fixture, "state") }, async () => {
        const retainedPaths = new Map<string, number>();
        let root = "";
        for (const label of ["a", "b", "c"]) {
          root = path.join(fixture, label);
          const { assetPath: asset } = await writeRetentionBuild(root, label, {
            size: 128 * 1024 + label.charCodeAt(0),
          });
          const owner = createControlUiAssetRetention(root);
          await owner.prepare();
          const retained = (await owner.resolveAsset(asset))!;
          retainedPaths.set(retained.filePath, 0);
        }
        let wholeFileReads = 0;
        const readFile = fs.readFile;
        const open = fs.open;
        vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
          const result = await readFile(...args);
          if (typeof args[0] === "string" && retainedPaths.has(args[0])) {
            wholeFileReads++;
          }
          return result;
        });
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (typeof args[0] !== "string" || !retainedPaths.has(args[0])) {
            return handle;
          }
          retainedPaths.set(args[0], retainedPaths.get(args[0])! + 1);
          const readWholeFile = handle.readFile.bind(handle);
          vi.spyOn(handle, "readFile").mockImplementation((...readArgs) => {
            wholeFileReads++;
            return readWholeFile(...readArgs);
          });
          return handle;
        });
        const owner = createControlUiAssetRetention(root);
        try {
          await owner.prepare();
        } finally {
          vi.restoreAllMocks();
        }
        expect(wholeFileReads).toBe(0);
        for (const [retained, opens] of retainedPaths) {
          expect(opens).toBe(1);
          expect((await owner.resolveAsset(`assets/${path.basename(retained)}`))?.filePath).toBe(
            retained,
          );
        }
      });
    } finally {
      vi.restoreAllMocks();
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it("defers verification, exposes verified fallback during copy failure, and retries rejected preparation", async () => {
    await withRetentionFixture(async ({ root, seed, cache }) => {
      const old = await seed("old");
      const current = await writeRetentionBuild(path.join(root, "current"), "current", {
        corrupt: true,
      });
      const owner = createControlUiAssetRetention(current.root);
      expect(await owner.resolveAsset(old.assetPath)).toBeNull();
      const open = fs.open;
      const observed = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (args[0] === path.join(current.root, current.assetPath)) {
          expect((await owner.resolveAsset(old.assetPath))?.filePath).toBe(
            path.join(old.target, old.assetPath),
          );
        }
        return open(...args);
      });
      const preparing = owner.prepare();
      expect(owner.prepare()).toBe(preparing);
      await expect(preparing).rejects.toThrow("changed while being retained");
      expect(observed).toHaveBeenCalled();
      expect(await owner.resolveAsset(old.assetPath)).not.toBeNull();
      expect(await fs.readdir(cache)).toEqual([old.manifest.generation]);
      await writeRetentionBuild(current.root, "current");
      await owner.prepare();
      expect(await owner.resolveAsset(current.assetPath)).not.toBeNull();
    });
  });

  it("skips generations larger than the hard cache budget before reading assets", async () => {
    await withRetentionFixture(async ({ root, cache }) => {
      const manifest = createRetentionManifest(
        ["a", "b"].map((label) => ({
          path: `assets/${label}.js`,
          sha256: "0".repeat(64),
          size: 50 * 1024 * 1024,
        })),
      );
      await fs.writeFile(
        path.join(root, CONTROL_UI_ASSET_MANIFEST_FILENAME),
        JSON.stringify(manifest),
      );
      const owner = createControlUiAssetRetention(root);
      await owner.prepare();
      expect(await owner.resolveAsset("assets/a.js")).toBeNull();
      expect(await fs.readdir(cache)).toEqual([]);
    });
  });

  it("prunes only generations and stale staging directories", async () => {
    await withRetentionFixture(async ({ seed, cache, root }) => {
      const current = await seed("current");
      const names = [".staging-1-aaaa", ".staging-2-bbbb", "unrelated", "e".repeat(64)] as const;
      for (const name of names) {
        await fs.mkdir(path.join(cache, name));
      }
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      await fs.utimes(
        path.join(cache, names[0]),
        new Date(now - 3_600_000),
        new Date(now - 3_600_000),
      );
      await fs.utimes(
        path.join(cache, names[1]),
        new Date(now - 3_599_000),
        new Date(now - 3_599_000),
      );
      await fs.writeFile(path.join(root, "sentinel"), "outside");
      await fs.symlink(root, path.join(cache, "f".repeat(64)), "dir");
      await createControlUiAssetRetention(current.root).prepare();
      expect((await fs.readdir(cache)).toSorted()).toEqual(
        [current.manifest.generation, names[1], names[2], "f".repeat(64)].toSorted((left, right) =>
          left.localeCompare(right),
        ),
      );
      expect(await fs.readFile(path.join(root, "sentinel"), "utf8")).toBe("outside");
    });
  });
});

describe("Control UI retained integrity", () => {
  it.each([
    "digest",
    "size",
    "missing",
    "manifest",
    "directory-name",
    "asset-symlink",
    "manifest-symlink",
    "directory-symlink",
  ] as const)("rejects cached %s corruption without disturbing outside bytes", async (fault) => {
    await withRetentionFixture(async ({ root, cache, seed }) => {
      const cached = await seed("cached");
      let cachedDirectory = cached.target;
      const asset = path.join(cached.target, cached.assetPath);
      const manifest = path.join(cached.target, "asset-manifest.json");
      const outside = path.join(root, "outside");
      await fs.cp(cached.target, outside, { recursive: true });
      switch (fault) {
        case "digest":
          await fs.writeFile(asset, Buffer.alloc(cached.manifest.assets[0]!.size, 120));
          break;
        case "size":
          await fs.writeFile(asset, "short");
          break;
        case "missing":
          await fs.rm(asset);
          break;
        case "manifest":
          await fs.writeFile(manifest, "{");
          break;
        case "directory-name":
          cachedDirectory = path.join(cache, "0".repeat(64));
          await fs.rename(cached.target, cachedDirectory);
          break;
        case "asset-symlink":
          await fs.rm(asset);
          await fs.symlink(path.join(outside, cached.assetPath), asset);
          break;
        case "manifest-symlink":
          await fs.rm(manifest);
          await fs.symlink(path.join(outside, "asset-manifest.json"), manifest);
          break;
        case "directory-symlink":
          await fs.rm(cached.target, { recursive: true });
          await fs.symlink(outside, cached.target, "dir");
          break;
      }
      const current = await writeRetentionBuild(path.join(root, "current"), "current");
      const owner = createControlUiAssetRetention(current.root);
      let checkedAdmission = false;
      const readFile = fs.readFile;
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (args[0] === path.join(current.root, "asset-manifest.json")) {
          checkedAdmission = true;
          expect(await owner.resolveAsset(cached.assetPath)).toBeNull();
        }
        return readFile(...args);
      });
      await owner.prepare();
      expect(checkedAdmission).toBe(true);
      expect(await owner.resolveAsset(cached.assetPath)).toBeNull();
      expect(await owner.resolveAsset(current.assetPath)).not.toBeNull();
      expect(await fs.readFile(path.join(outside, cached.assetPath), "utf8")).toContain("cached");
      expect((await fs.readdir(cache)).includes(path.basename(cachedDirectory))).toBe(
        fault === "directory-symlink",
      );
    });
  });

  it.each(["leaf-symlink", "parent-escape", "inode-swap"] as const)(
    "handles source %s during preparation",
    async (fault) => {
      await withRetentionFixture(async ({ root, cache }) => {
        const build = await writeRetentionBuild(path.join(root, "build"), "source", {
          size: fault === "inode-swap" ? 128 * 1024 : undefined,
        });
        const source = path.join(build.root, build.assetPath);
        const outside = path.join(root, "outside");
        await fs.cp(build.root, outside, { recursive: true });
        const outsideContents = await fs.readFile(path.join(outside, build.assetPath));
        if (fault === "leaf-symlink") {
          await fs.rm(source);
          await fs.symlink(path.join(outside, build.assetPath), source);
        } else if (fault === "parent-escape") {
          await fs.rm(path.join(build.root, "assets"), { recursive: true });
          await fs.symlink(path.join(outside, "assets"), path.join(build.root, "assets"), "dir");
        } else {
          const open = fs.open;
          vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (args[0] !== source) {
              return handle;
            }
            const read = handle.read.bind(handle);
            let replaced = false;
            vi.spyOn(handle, "read").mockImplementation((async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number | null,
            ) => {
              const result = await read(buffer, offset, length, position);
              if (!replaced && result.bytesRead > 0) {
                replaced = true;
                await fs.rename(source, `${source}.old`);
                await fs.writeFile(source, Buffer.alloc(build.manifest.assets[0]!.size, 120));
              }
              return result;
            }) as typeof handle.read);
            return handle;
          });
        }
        const owner = createControlUiAssetRetention(build.root);
        if (fault === "inode-swap") {
          await owner.prepare();
          expect(await fs.readFile((await owner.resolveAsset(build.assetPath))!.filePath)).toEqual(
            outsideContents,
          );
          expect(await fs.readFile(source)).not.toEqual(outsideContents);
          expect(await fs.readdir(cache)).toEqual([build.manifest.generation]);
        } else {
          await expect(owner.prepare()).rejects.toMatchObject({
            code: fault === "leaf-symlink" ? "symlink" : "outside-workspace",
          });
          expect(await owner.resolveAsset(build.assetPath)).toBeNull();
          expect(await fs.readdir(cache)).toEqual([]);
        }
        expect(await fs.readFile(path.join(outside, build.assetPath))).toEqual(outsideContents);
      });
    },
  );

  it("keeps the cached generation boundary when its directory is redirected", async () => {
    await withRetentionFixture(async ({ root, seed }) => {
      const cached = await seed("cached");
      const outside = path.join(root, "outside");
      await fs.cp(cached.target, outside, { recursive: true });
      const current = await writeRetentionBuild(path.join(root, "current"), "current");
      const readFile = fs.readFile;
      let redirected = false;
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        const result = await readFile(...args);
        if (!redirected && args[0] === path.join(cached.target, "asset-manifest.json")) {
          redirected = true;
          await fs.rename(cached.target, path.join(root, "displaced"));
          await fs.symlink(outside, cached.target, "dir");
        }
        return result;
      });
      const open = vi.spyOn(fs, "open");
      const owner = createControlUiAssetRetention(current.root);
      await owner.prepare();
      expect(redirected).toBe(true);
      expect(open.mock.calls.some(([file]) => file === path.join(outside, cached.assetPath))).toBe(
        false,
      );
      expect(await owner.resolveAsset(cached.assetPath)).toBeNull();
      expect(await owner.resolveAsset(current.assetPath)).not.toBeNull();
      expect(await fs.readFile(path.join(outside, cached.assetPath), "utf8")).toContain("cached");
    });
  });

  it("rejects a cached asset replaced while its admitted handle is read", async () => {
    await withRetentionFixture(async ({ root, cache, seed }) => {
      const cached = await seed("cached", { size: 128 * 1024 });
      const asset = path.join(cached.target, cached.assetPath);
      const current = await writeRetentionBuild(path.join(root, "current"), "current");
      const open = fs.open;
      let replaced = false;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (args[0] !== asset) {
          return handle;
        }
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation((async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          const result = await read(buffer, offset, length, position);
          if (!replaced && result.bytesRead > 0) {
            replaced = true;
            await fs.rename(asset, `${asset}.old`);
            await fs.writeFile(asset, Buffer.alloc(cached.manifest.assets[0]!.size, 120));
          }
          return result;
        }) as typeof handle.read);
        return handle;
      });
      const owner = createControlUiAssetRetention(current.root);
      await withEnvAsync({ FS_SAFE_NATIVE_MODE: "off" }, () => owner.prepare());
      expect(replaced).toBe(true);
      expect(await owner.resolveAsset(cached.assetPath)).toBeNull();
      expect(await owner.resolveAsset(current.assetPath)).not.toBeNull();
      await expect(fs.access(cached.target)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(cache)).some((entry) => entry.startsWith(".staging-"))).toBe(false);
    });
  });
});
