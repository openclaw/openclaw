import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePluginSdkDeclarationBuildRequirement } from "../../scripts/lib/run-extension-oxlint.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function writeFile(root: string, relativePath: string, content = "") {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function setMtime(filePath: string, iso: string) {
  const date = new Date(iso);
  fs.utimesSync(filePath, date, date);
}

describe("run-extension-oxlint plugin-sdk declarations", () => {
  it("requests a build when plugin-sdk declaration shims are missing", () => {
    const repoRoot = createTempDir("openclaw-extension-oxlint-");
    writeFile(repoRoot, "src/plugin-sdk/core.ts", "export type Core = string;\n");

    expect(resolvePluginSdkDeclarationBuildRequirement({ repoRoot })).toEqual({
      shouldBuild: true,
      reason: "missing_declarations",
    });
  });

  it("requests a build when plugin-sdk sources are newer than the declaration stamp", () => {
    const repoRoot = createTempDir("openclaw-extension-oxlint-");
    const sourcePath = writeFile(
      repoRoot,
      "src/plugin-sdk/core.ts",
      "export type Core = string;\n",
    );
    const entryPath = writeFile(
      repoRoot,
      "dist/plugin-sdk/index.d.ts",
      'export * from "./src/plugin-sdk/core.js";\n',
    );
    const stampPath = writeFile(
      repoRoot,
      "dist/plugin-sdk/.boundary-entry-shims.stamp",
      "2026-04-08T10:00:00.000Z\n",
    );

    setMtime(entryPath, "2026-04-08T10:00:00.000Z");
    setMtime(stampPath, "2026-04-08T10:00:00.000Z");
    setMtime(sourcePath, "2026-04-08T10:00:05.000Z");

    expect(resolvePluginSdkDeclarationBuildRequirement({ repoRoot })).toEqual({
      shouldBuild: true,
      reason: "stale_declarations",
    });
  });

  it("requests a build when plugin-sdk entrypoints change after the declaration stamp", () => {
    const repoRoot = createTempDir("openclaw-extension-oxlint-");
    const entrypointsPath = writeFile(
      repoRoot,
      "scripts/lib/plugin-sdk-entrypoints.json",
      '["index", "core"]\n',
    );
    const entryPath = writeFile(
      repoRoot,
      "dist/plugin-sdk/index.d.ts",
      'export * from "./src/plugin-sdk/core.js";\n',
    );
    const stampPath = writeFile(
      repoRoot,
      "dist/plugin-sdk/.boundary-entry-shims.stamp",
      "2026-04-08T10:00:00.000Z\n",
    );

    setMtime(entryPath, "2026-04-08T10:00:00.000Z");
    setMtime(stampPath, "2026-04-08T10:00:00.000Z");
    setMtime(entrypointsPath, "2026-04-08T10:00:05.000Z");

    expect(resolvePluginSdkDeclarationBuildRequirement({ repoRoot })).toEqual({
      shouldBuild: true,
      reason: "stale_declarations",
    });
  });

  it("skips the build when declaration shims are present and newer than the inputs", () => {
    const repoRoot = createTempDir("openclaw-extension-oxlint-");
    const sourcePath = writeFile(
      repoRoot,
      "src/plugin-sdk/core.ts",
      "export type Core = string;\n",
    );
    const tsconfigPath = writeFile(repoRoot, "tsconfig.plugin-sdk.dts.json", "{\n}\n");
    const entrypointsPath = writeFile(
      repoRoot,
      "scripts/lib/plugin-sdk-entrypoints.json",
      '["index", "core"]\n',
    );
    const entryPath = writeFile(
      repoRoot,
      "dist/plugin-sdk/index.d.ts",
      'export * from "./src/plugin-sdk/core.js";\n',
    );
    const stampPath = writeFile(
      repoRoot,
      "dist/plugin-sdk/.boundary-entry-shims.stamp",
      "2026-04-08T10:00:10.000Z\n",
    );

    setMtime(sourcePath, "2026-04-08T10:00:00.000Z");
    setMtime(tsconfigPath, "2026-04-08T10:00:00.000Z");
    setMtime(entrypointsPath, "2026-04-08T10:00:00.000Z");
    setMtime(entryPath, "2026-04-08T10:00:10.000Z");
    setMtime(stampPath, "2026-04-08T10:00:10.000Z");

    expect(resolvePluginSdkDeclarationBuildRequirement({ repoRoot })).toEqual({
      shouldBuild: false,
      reason: "fresh_declarations",
    });
  });
});
