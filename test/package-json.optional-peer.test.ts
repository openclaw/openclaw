import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type RootPackageJson = {
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

describe("package.json optional peer deps", () => {
  it("marks node-llama-cpp as an optional peer dependency", () => {
    const packageJsonPath = path.resolve(import.meta.dirname, "../package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as RootPackageJson;

    expect(packageJson.peerDependencies?.["node-llama-cpp"]).toBeDefined();
    expect(packageJson.peerDependenciesMeta?.["node-llama-cpp"]?.optional).toBe(true);
  });
});
