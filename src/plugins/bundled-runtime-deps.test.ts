import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type PackageManifest = {
  dependencies?: Record<string, string>;
};

function readJson<T>(relativePath: string): T {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as T;
}

function expectMirroredRootDependencies(relativePath: string, deps: string[]) {
  const rootManifest = readJson<PackageManifest>("package.json");
  const extensionManifest = readJson<PackageManifest>(relativePath);

  for (const dep of deps) {
    expect(extensionManifest.dependencies?.[dep], `${relativePath}:${dep}`).toBeTruthy();
    expect(rootManifest.dependencies?.[dep], `package.json:${dep}`).toBeTruthy();
    expect(rootManifest.dependencies?.[dep], `package.json:${dep}`).toBe(
      extensionManifest.dependencies?.[dep],
    );
  }
}

describe("bundled plugin runtime dependencies", () => {
  it("keeps bundled Feishu runtime deps available from the published root package", () => {
    expectMirroredRootDependencies("extensions/feishu/package.json", ["@larksuiteoapi/node-sdk"]);
  });

  it("keeps bundled memory-lancedb runtime deps available from the published root package", () => {
    expectMirroredRootDependencies("extensions/memory-lancedb/package.json", [
      "@lancedb/lancedb",
      "openai",
    ]);
  });
});
