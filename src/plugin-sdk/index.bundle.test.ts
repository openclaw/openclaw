import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildPluginSdkEntrySources, pluginSdkEntrypoints } from "./entrypoints.js";

const require = createRequire(import.meta.url);
const tsdownModuleUrl = pathToFileURL(require.resolve("tsdown")).href;
const bundledRepresentativeEntrypoints = ["matrix-runtime-heavy"] as const;
const bundledCoverageEntrySources = buildPluginSdkEntrySources(bundledRepresentativeEntrypoints);

describe("plugin-sdk bundled exports", () => {
  it("emits importable bundled subpath entries", { timeout: 120_000 }, async () => {
    const bundleCacheRoot = path.join(process.cwd(), "node_modules", ".cache");
    await fs.mkdir(bundleCacheRoot, { recursive: true });
    const bundleTempRoot = await fs.mkdtemp(
      path.join(bundleCacheRoot, "openclaw-plugin-sdk-build-"),
    );
    const outDir = path.join(bundleTempRoot, "bundle");
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.mkdir(outDir, { recursive: true });

    const { build } = await import(tsdownModuleUrl);
    await build({
      clean: false,
      config: false,
      dts: false,
      // Full plugin-sdk coverage belongs to `pnpm build`, package contract
      // guardrails, and `subpaths.test.ts`. This file only keeps the expensive
      // bundler path honest across representative entrypoint families.
      entry: bundledCoverageEntrySources,
      env: { NODE_ENV: "production" },
      fixedExtension: false,
      logLevel: "error",
      outDir,
      platform: "node",
    });

    expect(pluginSdkEntrypoints.length).toBeGreaterThan(bundledRepresentativeEntrypoints.length);
    await Promise.all(
      bundledRepresentativeEntrypoints.map(async (entry) => {
        await expect(fs.stat(path.join(outDir, `${entry}.js`))).resolves.toBeTruthy();
      }),
    );

    // Export list and package-specifier coverage already live in
    // package-contract-guardrails.test.ts and subpaths.test.ts. Keep this file
    // focused on the expensive part: can tsdown emit working bundle artifacts?
    const importResults = await Promise.all(
      bundledRepresentativeEntrypoints.map(async (entry) => [
        entry,
        typeof (await import(pathToFileURL(path.join(outDir, `${entry}.js`)).href)),
      ]),
    );
    expect(Object.fromEntries(importResults)).toEqual(
      Object.fromEntries(bundledRepresentativeEntrypoints.map((entry) => [entry, "object"])),
    );
  });
});
