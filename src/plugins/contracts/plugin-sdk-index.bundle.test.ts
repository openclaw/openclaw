import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";
import {
  buildPluginSdkEntrySources,
  pluginSdkEntrypoints,
} from "../../../scripts/lib/plugin-sdk-entries.mts";
import { createSyncSuiteTempRootTracker } from "../test-helpers/fs-fixtures.js";
import { resolveBundledPluginFile } from "./test-helpers/bundled-plugin-roots.js";

const require = createRequire(import.meta.url);
const tsdownModuleUrl = pathToFileURL(require.resolve("tsdown")).href;
const bundledRepresentativeEntrypoints = ["browser-config"] as const;
const bundleTempRootTracker = createSyncSuiteTempRootTracker(
  "openclaw-plugin-sdk-build",
  path.join(process.cwd(), "node_modules", ".cache"),
);
const bundledCoverageEntrySources = {
  ...buildPluginSdkEntrySources(bundledRepresentativeEntrypoints),
  "matrix-runtime-sdk": resolveBundledPluginFile({
    pluginId: "matrix",
    relativePath: "src/matrix/sdk.ts",
  }),
};
const bareMatrixSdkImportPattern = /(?:from|require|import)\s*\(?\s*["']matrix-js-sdk["']/;

async function listBuiltJsFiles(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
          return listBuiltJsFiles(entryPath);
        }
        return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
      }),
    )
  ).flat();
}

afterAll(() => bundleTempRootTracker.cleanup());

it("emits importable bundled subpath entries", { timeout: 120_000 }, async () => {
  const outDir = path.join(bundleTempRootTracker.ensureSuiteTempRoot(), "bundle");
  await fs.mkdir(outDir, { recursive: true });

  const { build } = await import(tsdownModuleUrl);
  await build({
    clean: false,
    config: false,
    dts: false,
    deps: {
      // Keep Matrix entrypoints external, matching the production host build.
      neverBundle: ["@lancedb/lancedb", "@matrix-org/matrix-sdk-crypto-nodejs", "matrix-js-sdk"],
    },
    // Subpath/package tests cover the inventory. Mixing bare and deep Matrix
    // SDK imports historically crashed loading; retain its bundled-runtime proof.
    entry: bundledCoverageEntrySources,
    env: { NODE_ENV: "production" },
    fixedExtension: false,
    logLevel: "error",
    outDir,
    platform: "node",
  });

  expect(pluginSdkEntrypoints.length).toBeGreaterThan(bundledRepresentativeEntrypoints.length);
  for (const entry of Object.keys(bundledCoverageEntrySources)) {
    const stat = await fs.stat(path.join(outDir, `${entry}.js`));
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(0);
  }
  const builtJsFiles = await listBuiltJsFiles(outDir);
  const filesWithBareMatrixSdkImports = (
    await Promise.all(
      builtJsFiles.map(async (filePath) =>
        bareMatrixSdkImportPattern.test(await fs.readFile(filePath, "utf8")) ? filePath : null,
      ),
    )
  ).filter((filePath): filePath is string => filePath !== null);
  expect(filesWithBareMatrixSdkImports).toStrictEqual([]);

  for (const entry of bundledRepresentativeEntrypoints) {
    expect(typeof (await import(pathToFileURL(path.join(outDir, `${entry}.js`)).href))).toBe(
      "object",
    );
  }
});
