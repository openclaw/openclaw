import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { createControlUiAssetRetention } from "./control-ui-asset-retention.js";
import {
  withRetentionFixture,
  writeRetentionBuild,
} from "./control-ui-asset-retention.test-support.js";

const boundaries = [
  "before-start",
  "retained-read",
  "source-read",
  "asset-write",
  "manifest-write",
  "rename-issued",
  "refresh",
  "prune-issued",
  "projection",
] as const;

describe("Control UI retention cancellation", () => {
  it.each(boundaries)("stops at %s and cleans only its staging", async (boundary) => {
    await withRetentionFixture(async ({ root, cache, seed }) => {
      const old = await seed("old");
      const build =
        boundary === "refresh"
          ? old
          : await writeRetentionBuild(path.join(root, "current"), "current", {
              size: 128 * 1024,
            });
      const target = path.join(cache, build.manifest.generation);
      const assetSuffix = path.join(path.sep, build.assetPath);
      const stale = [".staging-1-aaaa", ".staging-2-bbbb"].map((name) => path.join(cache, name));
      for (const directory of stale) {
        await fs.mkdir(directory);
        await fs.utimes(directory, 0, 0);
      }
      const owner = createControlUiAssetRetention(build.root);
      const controller = new AbortController();
      let readsAfterAbort = 0;
      let writesAfterAbort = 0;
      let published = false;
      const closed = new Set<string>();
      const pruned = new Set<string>();
      const pruning = new Map<string, string>();
      const cancel = () => {
        controller.abort();
      };
      const original = {
        readFile: fs.readFile,
        writeFile: fs.writeFile,
        open: fs.open,
        rename: fs.rename,
        lstat: fs.lstat,
        rm: fs.rm,
      };
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        const result = await original.readFile(...args);
        if (boundary === "refresh" && args[0] === path.join(build.root, "asset-manifest.json")) {
          cancel();
        }
        return result;
      });
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await original.open(...args);
        const file = args[0];
        if (typeof file !== "string") {
          return handle;
        }
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation((async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          if (controller.signal.aborted) {
            readsAfterAbort++;
          }
          const result = await read(buffer, offset, length, position);
          if (
            (boundary === "retained-read" && file === path.join(old.target, old.assetPath)) ||
            (boundary === "source-read" && file === path.join(build.root, build.assetPath))
          ) {
            cancel();
          }
          return result;
        }) as typeof handle.read);
        const write = handle.write.bind(handle);
        vi.spyOn(handle, "write").mockImplementation((async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          if (controller.signal.aborted) {
            writesAfterAbort++;
          }
          const result = await write(buffer, offset, length, position);
          if (
            boundary === "asset-write" &&
            file.includes(".staging-") &&
            file.endsWith(assetSuffix)
          ) {
            cancel();
          }
          return result;
        }) as typeof handle.write);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          await close();
          closed.add(file);
        });
        return handle;
      });
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        await original.writeFile(...args);
        const file = args[0];
        if (
          boundary === "manifest-write" &&
          typeof file === "string" &&
          file.includes(".staging-") &&
          path.basename(file) === "asset-manifest.json"
        ) {
          cancel();
        }
      });
      const renames: string[] = [];
      vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        await original.rename(...args);
        if (stale.includes(String(args[0]))) {
          pruning.set(path.dirname(String(args[1])), String(args[0]));
          return;
        }
        renames.push(String(args[1]));
        published = true;
        if (boundary === "rename-issued") {
          cancel();
        }
      });
      const refreshes = vi.spyOn(fs, "utimes");
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const result = await original.lstat(...args);
        if (boundary === "projection" && pruned.size > 0 && args[0] === target) {
          cancel();
        }
        return result;
      });
      vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        await original.rm(...args);
        const directory = pruning.get(String(args[0]));
        if (directory) {
          pruned.add(directory);
          if (boundary === "prune-issued") {
            cancel();
          }
        }
      });
      if (boundary === "before-start") {
        cancel();
      }
      const nativeModeEnv = captureEnv(["FS_SAFE_NATIVE_MODE"]);
      try {
        if (boundary === "retained-read") {
          // Inject a deterministic abort during hashing through the supported JS backend.
          setTestEnvValue("FS_SAFE_NATIVE_MODE", "off");
        }
        await expect(owner.prepare({ signal: controller.signal })).rejects.toMatchObject({
          name: "AbortError",
        });
      } finally {
        nativeModeEnv.restore();
      }
      expect(controller.signal.aborted).toBe(true);
      expect(readsAfterAbort).toBe(0);
      expect(writesAfterAbort).toBe(0);
      expect(published).toBe(["rename-issued", "prune-issued", "projection"].includes(boundary));
      expect(pruned.size).toBe(boundary === "projection" ? 2 : boundary === "prune-issued" ? 1 : 0);
      expect(renames).toHaveLength(published ? 1 : 0);
      expect(refreshes).toHaveBeenCalledTimes(
        ["prune-issued", "projection"].includes(boundary) ? 1 : 0,
      );
      if (boundary === "source-read" || boundary === "asset-write") {
        expect(closed).toContain(path.join(build.root, build.assetPath));
        expect(
          [...closed].some((file) => file.includes(".staging-") && file.endsWith(assetSuffix)),
        ).toBe(true);
      }
      vi.restoreAllMocks();
      expect(
        (await fs.readdir(cache)).filter(
          (name) => name.startsWith(".staging-") && !stale.includes(path.join(cache, name)),
        ),
      ).toEqual([]);
      for (const directory of stale) {
        expect(
          await fs.access(directory).then(
            () => true,
            () => false,
          ),
        ).toBe(!pruned.has(directory));
      }
      expect(await fs.readFile(path.join(old.target, old.assetPath), "utf8")).toContain("old");
      if (boundary !== "refresh") {
        expect(owner.resolveAsset(build.assetPath)).toBeNull();
        expect(
          await fs.access(target).then(
            () => true,
            () => false,
          ),
        ).toBe(published);
      }
    });
  });
});
