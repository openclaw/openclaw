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

describe("extension openclaw peer dependency floors", () => {
  it("pins googlechat and memory-core peers to patched openclaw versions", () => {
    const manifests = [
      readManifest("extensions/googlechat/package.json"),
      readManifest("extensions/memory-core/package.json"),
    ];

    for (const manifest of manifests) {
      const range = manifest.peerDependencies?.openclaw;
      expect(range).toBe(">=2026.3.2");
    }
  });
});
