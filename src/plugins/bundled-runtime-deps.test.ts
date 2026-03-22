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

describe("bundled plugin runtime dependencies", () => {
  it("keeps bundled Feishu runtime deps available from the published root package", () => {
    const rootManifest = readJson<PackageManifest>("package.json");
    const feishuManifest = readJson<PackageManifest>("extensions/feishu/package.json");
    const feishuSpec = feishuManifest.dependencies?.["@larksuiteoapi/node-sdk"];
    const rootSpec = rootManifest.dependencies?.["@larksuiteoapi/node-sdk"];

    expect(feishuSpec).toBeTruthy();
    expect(rootSpec).toBeTruthy();
    expect(rootSpec).toBe(feishuSpec);
  });

  it("keeps bundled memory-lancedb runtime deps available from the published root package", () => {
    const rootManifest = readJson<PackageManifest>("package.json");
    const memoryManifest = readJson<PackageManifest>("extensions/memory-lancedb/package.json");
    const memorySpec = memoryManifest.dependencies?.["@lancedb/lancedb"];
    const rootSpec = rootManifest.dependencies?.["@lancedb/lancedb"];

    expect(memorySpec).toBeTruthy();
    expect(rootSpec).toBeTruthy();
    expect(rootSpec).toBe(memorySpec);
  });
});
