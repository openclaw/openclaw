import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolvePackageRuntimeExtensionSources,
  resolvePackageSetupSource,
  validatePackageExtensionEntriesForInstall,
} from "./package-entry-resolution.js";
import {
  clearPluginRuntimeArtifactResolutionMemo,
  resolvePluginRuntimeArtifact,
} from "./plugin-runtime-artifact-resolution.js";
import { writeArtifacts as writeTree } from "./public-surface.test-support.js";

const temp = createTempDirTracker();
type Resolution = Parameters<typeof resolvePackageRuntimeExtensionSources>[0] &
  Parameters<typeof validatePackageExtensionEntriesForInstall>[0];

function fixture(ext: string, outputs: readonly string[], includeSource = true) {
  const packageDir = temp.make("openclaw-package-runtime-entry-");
  const sourceEntry = `./src/entry${ext}`;
  const entries = [...outputs, ...(includeSource ? [sourceEntry] : [])];
  writeTree(
    packageDir,
    Object.fromEntries(entries.map((entry) => [entry, "export default {};\n"])),
  );
  const resolution: Resolution = {
    packageDir,
    extensions: [sourceEntry],
    origin: "global",
    sourceLabel: packageDir,
    diagnostics: [],
    manifest: { openclaw: { extensions: [sourceEntry], setupEntry: sourceEntry } },
  };
  return { sourceEntry, resolution };
}

afterEach(() => {
  clearPluginRuntimeArtifactResolutionMemo();
  temp.cleanup();
});

it.each([
  [".tsx", ["dist/entry.js"], "dist/entry.js", true],
  [".tsx", ["dist/entry.js"], "dist/entry.js", false],
  [".ts", ["dist/src/entry.js"], "dist/src/entry.js", true],
  [".mts", ["dist/entry.js", "dist/entry.mjs"], "dist/entry.mjs", true],
  [".cts", ["dist/entry.js", "dist/entry.cjs"], "dist/entry.cjs", true],
] as const)(
  "aligns install, discovery, setup, and loading: %s %j %s %s",
  async (sourceExtension, runtimeOutputs, expectedRuntime, includeSource) => {
    const { sourceEntry, resolution } = fixture(sourceExtension, runtimeOutputs, includeSource);
    const { packageDir } = resolution;
    const install = await validatePackageExtensionEntriesForInstall(resolution);
    const runtime = resolvePackageRuntimeExtensionSources(resolution);
    const setup = resolvePackageSetupSource(resolution);
    const artifact = resolvePluginRuntimeArtifact({
      pluginId: "runtime-entry-fixture",
      entryKind: "runtime",
      source: path.join(packageDir, sourceEntry),
      rootDir: packageDir,
      origin: "global",
      preferBuiltPluginArtifacts: true,
    });
    const expectedSource = fs.realpathSync(path.join(packageDir, expectedRuntime));

    expect([install, runtime, setup, artifact.source, resolution.diagnostics]).toEqual([
      { ok: true },
      [expectedSource],
      expectedSource,
      expectedSource,
      [],
    ]);
  },
);

it("rejects published source-only entries while allowing linked source checkouts", async () => {
  const { sourceEntry, resolution } = fixture(".ts", ["index.js"]);
  const { packageDir, manifest } = resolution;
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
  expect(resolvePackageRuntimeExtensionSources(resolution)).toEqual([]);
  expect(resolution.diagnostics).toEqual([
    expect.objectContaining({
      message: expect.stringContaining("requires compiled runtime output"),
    }),
  ]);
  expect(
    resolvePackageRuntimeExtensionSources({
      ...resolution,
      requireBuiltRuntimeEntry: false,
      diagnostics: [],
    }),
  ).toEqual([fs.realpathSync(path.join(packageDir, sourceEntry))]);
});
