import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { discoverStandaloneWorkers } from "../../scripts/lib/bun-standalone-workers.mjs";
import { runtimeProcessBuildEntrypoints } from "../../scripts/lib/runtime-process-build-entries.mts";
import {
  copyStaticExtensionAssetsToRuntimeOverlay,
  discoverStaticExtensionAssets,
} from "../../scripts/lib/static-extension-assets.mts";
import {
  createStandaloneRuntimeProcessEntrypoints,
  pluginRuntimeProcessManifest,
} from "../../src/infra/runtime-process-manifest.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("retains declared copied process assets without compiling them a second time", () => {
  const rootDir = fileURLToPath(new URL("../../", import.meta.url));
  const runtimeRoot = tempDirs.make("static-process-entries-");
  fs.mkdirSync(path.join(runtimeRoot, "dist", "extensions"), { recursive: true });
  const assets = discoverStaticExtensionAssets({ rootDir, includeExternalPlugins: true });
  copyStaticExtensionAssetsToRuntimeOverlay({
    rootDir,
    runtimeRoot: path.join(runtimeRoot, "dist"),
    assets,
  });

  const names = new Set<string>();
  const plugins = new Set<string>();
  for (const [name, entry] of Object.entries(pluginRuntimeProcessManifest)) {
    if (!("build" in entry)) {
      continue;
    }
    names.add(`plugin:${name}`);
    plugins.add(entry.plugin);
    expect(
      runtimeProcessBuildEntrypoints.some((built) => built.distWorkerPath === entry.distWorkerPath),
    ).toBe(false);
    const output = `dist/${entry.distWorkerPath}`;
    const asset = assets.find((candidate) => candidate.dest === output);
    if (!asset) {
      throw new Error(`Missing copy declaration for ${name}`);
    }
    expect(fs.readFileSync(path.join(runtimeRoot, output))).toEqual(
      fs.readFileSync(path.join(rootDir, asset.src)),
    );
  }
  expect(names.size).toBeGreaterThan(0);
  const declarations = createStandaloneRuntimeProcessEntrypoints(import.meta.url, [...plugins]);
  const selected = Object.fromEntries(
    Object.entries(declarations).filter(([name]) => names.has(name)),
  );
  expect(discoverStandaloneWorkers({ runtimeRoot, runtimeEntrypoints: selected })).toHaveLength(
    names.size,
  );
});
