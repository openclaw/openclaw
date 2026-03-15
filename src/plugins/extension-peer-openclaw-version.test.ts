import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type Manifest = {
  peerDependencies?: Record<string, string>;
};

function readManifest(relativePath: string): Manifest {
  const absolute = path.resolve(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolute, "utf8")) as Manifest;
}

function parseFloor(range: string): [number, number, number] {
  const match = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!match) {
    throw new Error(`Unexpected openclaw peer range format: ${range}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function gteVersion(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) {
      return true;
    }
    if (a[i] < b[i]) {
      return false;
    }
  }
  return true;
}

describe("extension openclaw peer dependency floors", () => {
  it("keeps googlechat and memory-core peers in sync at or above the patched floor", () => {
    const manifests = [
      readManifest("extensions/googlechat/package.json"),
      readManifest("extensions/memory-core/package.json"),
    ];

    const ranges = manifests.map((manifest) => manifest.peerDependencies?.openclaw);
    for (const range of ranges) {
      expect(range).toBeTypeOf("string");
    }

    const [firstRange, ...restRanges] = ranges as string[];
    for (const range of restRanges) {
      expect(range).toBe(firstRange);
    }

    const floor = parseFloor(firstRange);
    // Guard against regressions below the known patched baseline.
    expect(gteVersion(floor, [2026, 3, 2])).toBe(true);
  });
});
