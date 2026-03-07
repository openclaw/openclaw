import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("plugin-sdk package exports map", () => {
  it("keeps legacy keyed-async-queue subpath alias for published plugins", () => {
    const packageJsonPath = resolve(import.meta.dirname, "../../package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const exportsMap = packageJson.exports as Record<string, { default?: string; types?: string }>;

    expect(exportsMap["./plugin-sdk/index.js/keyed-async-queue"]).toEqual({
      types: "./dist/plugin-sdk/keyed-async-queue.d.ts",
      default: "./dist/plugin-sdk/keyed-async-queue.js",
    });
  });
});
