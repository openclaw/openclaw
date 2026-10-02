import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CONTROL_UI_ASSET_MANIFEST_FILENAME } from "./control-ui-asset-manifest.js";
import { createControlUiAssetRetention } from "./control-ui-asset-retention.js";
import {
  createRetentionManifest,
  withRetentionFixture,
  writeRetentionBuild,
} from "./control-ui-asset-retention.test-support.js";

const pruneLogs = vi.hoisted(() => ({ debug: vi.fn(), warn: vi.fn() }));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => pruneLogs }));

// Measured from the 2026-10-01 production build: identity, Brotli, and gzip bytes.
const BUILD_SIZES = [35_090_278, 8_430_582, 9_593_000] as const;
const zeroBuffer = Buffer.alloc(64 * 1024);
const zeroDigests = new Map<number, string>();

function sparseEntry(assetPath: string, size: number) {
  let sha256 = zeroDigests.get(size);
  if (!sha256) {
    const hash = createHash("sha256");
    for (let remaining = size; remaining > 0; remaining -= zeroBuffer.length) {
      hash.update(zeroBuffer.subarray(0, Math.min(remaining, zeroBuffer.length)));
    }
    sha256 = hash.digest("hex");
    zeroDigests.set(size, sha256);
  }
  return { path: assetPath, size, sha256 };
}

async function writeSparseBuild(
  root: string,
  manifest: ReturnType<typeof createRetentionManifest>,
) {
  for (const entry of manifest.assets) {
    const file = path.join(root, entry.path);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Sparse zero-filled fixtures avoid writing payloads outside the owner's publication.
    await fs.writeFile(file, "");
    await fs.truncate(file, entry.size);
  }
  await fs.writeFile(path.join(root, CONTROL_UI_ASSET_MANIFEST_FILENAME), JSON.stringify(manifest));
}

// One identity chunk with both precompressed sidecars, shaped like the measured build.
function realisticBuild(root: string, label: string) {
  const assetPath = `assets/app-${label}.js`;
  const identity = sparseEntry(assetPath, BUILD_SIZES[0]);
  return {
    assetPath,
    root: path.join(root, label),
    full: createRetentionManifest([
      identity,
      sparseEntry(`${assetPath}.br`, BUILD_SIZES[1]),
      sparseEntry(`${assetPath}.gz`, BUILD_SIZES[2]),
    ]),
    retained: createRetentionManifest([identity]),
  };
}

describe("Control UI asset retention budget", () => {
  it("keeps a realistically sized previous build when the next build publishes", async () => {
    await withRetentionFixture(async ({ root, cache }) => {
      pruneLogs.warn.mockClear();
      const previous = realisticBuild(root, "previous");
      const next = realisticBuild(root, "next");
      // The previous Gateway version published full generations, sidecars included.
      const previousTarget = path.join(cache, previous.full.generation);
      await writeSparseBuild(previousTarget, previous.full);
      await fs.utimes(previousTarget, 1_700_000_000, 1_700_000_000);
      await writeSparseBuild(next.root, next.full);
      const owner = createControlUiAssetRetention(next.root);
      await owner.prepare();

      // Identity next + full previous = 88,204,138 B; two full builds exceed the 96 MiB budget.
      expect((await owner.resolveAsset(previous.assetPath))?.filePath).toBe(
        path.join(previousTarget, previous.assetPath),
      );
      const nextTarget = path.join(cache, next.retained.generation);
      expect((await owner.resolveAsset(next.assetPath))?.filePath).toBe(
        path.join(nextTarget, next.assetPath),
      );
      expect(
        JSON.parse(
          await fs.readFile(path.join(nextTarget, CONTROL_UI_ASSET_MANIFEST_FILENAME), "utf8"),
        ),
      ).toEqual(next.retained);
      for (const extension of ["br", "gz"]) {
        await expect(
          fs.access(path.join(nextTarget, `${next.assetPath}.${extension}`)),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect((await fs.readdir(cache)).toSorted()).toEqual(
        [previous.full.generation, next.retained.generation].toSorted(),
      );
      expect(pruneLogs.warn).not.toHaveBeenCalled();
    });
  });

  it("warns when the byte budget cannot keep the previous generation", async () => {
    await withRetentionFixture(async ({ root, cache }) => {
      pruneLogs.warn.mockClear();
      const prior = createRetentionManifest([
        sparseEntry("assets/prior-a.js", 48 * 1024 * 1024),
        sparseEntry("assets/prior-b.js", 48 * 1024 * 1024),
      ]);
      const priorTarget = path.join(cache, prior.generation);
      await writeSparseBuild(priorTarget, prior);
      await fs.utimes(priorTarget, 1_700_000_000, 1_700_000_000);
      const current = await writeRetentionBuild(path.join(root, "current"), "current");
      const owner = createControlUiAssetRetention(current.root);
      await owner.prepare();

      expect(pruneLogs.warn).toHaveBeenCalledExactlyOnceWith(
        "Control UI asset retention cannot keep the previous generation",
        {
          generation: prior.generation,
          bytes: 100_663_296,
          retainedBytes: current.manifest.assets[0]!.size,
          maxBytes: 100_663_296,
        },
      );
      for (const entry of prior.assets) {
        expect(await owner.resolveAsset(entry.path)).toBeNull();
      }
      await expect(fs.access(priorTarget)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await owner.resolveAsset(current.assetPath))?.filePath).toBe(
        path.join(cache, current.manifest.generation, current.assetPath),
      );
      expect(await fs.readdir(cache)).toEqual([current.manifest.generation]);
    });
  });
});
