import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PackageManifest } from "./manifest.js";
import {
  resolvePackageRuntimeExtensionSources,
  resolvePackageSetupSource,
  validatePackageExtensionEntriesForInstall,
} from "./package-entry-resolution.js";
import {
  clearPluginRuntimeArtifactResolutionMemo,
  resolvePluginRuntimeArtifact,
} from "./plugin-runtime-artifact-resolution.js";

const packageRoots: string[] = [];

function createPackageFixture(params: {
  sourceExtension: string;
  runtimeOutputs?: readonly string[];
  includeSource?: boolean;
}): {
  packageDir: string;
  sourceEntry: string;
  manifest: PackageManifest;
  resolution: Omit<Parameters<typeof resolvePackageRuntimeExtensionSources>[0], "manifest">;
} {
  const packageDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-runtime-entry-")),
  );
  packageRoots.push(packageDir);
  const sourceEntry = `./src/entry${params.sourceExtension}`;
  if (params.includeSource !== false) {
    fs.mkdirSync(path.join(packageDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, sourceEntry), "export default {};\n");
  }
  for (const relativeOutput of params.runtimeOutputs ?? []) {
    const outputPath = path.join(packageDir, relativeOutput);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "export default {};\n");
  }
  return {
    packageDir,
    sourceEntry,
    resolution: {
      packageDir,
      extensions: [sourceEntry],
      origin: "global",
      sourceLabel: packageDir,
      diagnostics: [],
    },
    manifest: {
      name: "runtime-entry-fixture",
      version: "1.0.0",
      openclaw: { extensions: [sourceEntry], setupEntry: sourceEntry },
    },
  };
}

afterEach(() => {
  clearPluginRuntimeArtifactResolutionMemo();
  for (const packageRoot of packageRoots.splice(0)) {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});

describe("canonical installed package runtime entries", () => {
  it.each([
    [".tsx", ["dist/entry.js"], "dist/entry.js", true],
    [".tsx", ["dist/entry.js"], "dist/entry.js", false],
    [".ts", ["dist/src/entry.js"], "dist/src/entry.js", true],
    [".mts", ["dist/entry.js", "dist/entry.mjs"], "dist/entry.mjs", true],
    [".cts", ["dist/entry.js", "dist/entry.cjs"], "dist/entry.cjs", true],
  ] as const)(
    "aligns install, discovery, setup, and loading: %s, outputs %j, selected %s, source %s",
    async (sourceExtension, runtimeOutputs, expectedRuntime, includeSource) => {
      const { packageDir, sourceEntry, manifest, resolution } = createPackageFixture({
        sourceExtension,
        runtimeOutputs,
        includeSource,
      });
      const installResult = await validatePackageExtensionEntriesForInstall({
        packageDir,
        extensions: [sourceEntry],
        manifest,
      });
      const runtimeSources = resolvePackageRuntimeExtensionSources({ ...resolution, manifest });
      const setupSource = resolvePackageSetupSource({ ...resolution, manifest });
      const artifact = resolvePluginRuntimeArtifact({
        pluginId: "runtime-entry-fixture",
        entryKind: "runtime",
        source: path.join(packageDir, sourceEntry),
        rootDir: packageDir,
        origin: "global",
        preferBuiltPluginArtifacts: true,
      });
      const expectedSource = fs.realpathSync(path.join(packageDir, expectedRuntime));

      expect(installResult).toEqual({ ok: true });
      expect(runtimeSources).toEqual([expectedSource]);
      expect(setupSource).toBe(expectedSource);
      expect(artifact.source).toBe(expectedSource);
      expect(resolution.diagnostics).toEqual([]);
    },
  );

  it.each([".ts", ".tsx", ".mts", ".cts"])(
    "rejects published source-only %s entries while allowing linked source checkouts",
    async (sourceExtension) => {
      const { packageDir, sourceEntry, manifest, resolution } = createPackageFixture({
        sourceExtension,
        runtimeOutputs: ["index.js"],
      });
      // A valid JS extension lets the source-only setup entry reach its own validation.
      for (const extensions of [[sourceEntry], ["./index.js"]]) {
        const installParams = {
          packageDir,
          extensions,
          manifest: { ...manifest, openclaw: { ...manifest.openclaw, extensions } },
        };
        expect(await validatePackageExtensionEntriesForInstall(installParams)).toEqual({
          ok: false,
          error: expect.stringContaining("requires compiled runtime output"),
        });
        expect(
          await validatePackageExtensionEntriesForInstall({
            ...installParams,
            allowSourceTypeScriptEntries: true,
          }),
        ).toEqual({ ok: true });
      }
      expect(resolvePackageRuntimeExtensionSources({ ...resolution, manifest })).toEqual([]);
      expect(resolution.diagnostics).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("requires compiled runtime output"),
        }),
      ]);
      expect(
        resolvePackageRuntimeExtensionSources({
          ...resolution,
          manifest,
          requireBuiltRuntimeEntry: false,
          diagnostics: [],
        }),
      ).toEqual([fs.realpathSync(path.join(packageDir, sourceEntry))]);
    },
  );
});
