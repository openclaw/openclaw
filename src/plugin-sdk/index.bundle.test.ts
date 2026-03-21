import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildPluginSdkEntrySources, pluginSdkEntrypoints } from "./entrypoints.js";

const require = createRequire(import.meta.url);
const tsdownModuleUrl = pathToFileURL(require.resolve("tsdown")).href;
const bundledSmokeEntrypoints = [
  "index",
  "core",
  "runtime",
  "channel-runtime",
  "provider-setup",
  "setup",
  "matrix-runtime-heavy",
  "windows-spawn",
  "gateway-runtime",
  "plugin-runtime",
  "testing",
] as const;

describe("plugin-sdk bundled exports", () => {
  it("emits importable bundled subpath entries", { timeout: 240_000 }, async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-sdk-build-"));

    try {
      const { build } = await import(tsdownModuleUrl);
      await build({
        clean: true,
        config: false,
        dts: false,
        entry: buildPluginSdkEntrySources(),
        env: { NODE_ENV: "production" },
        fixedExtension: false,
        logLevel: "error",
        outDir,
        platform: "node",
      });
      await fs.symlink(
        path.join(process.cwd(), "node_modules"),
        path.join(outDir, "node_modules"),
        "dir",
      );

      await Promise.all(
        pluginSdkEntrypoints.map(async (entry) => {
          await expect(fs.stat(path.join(outDir, `${entry}.js`))).resolves.toBeTruthy();
        }),
      );

      // Export list and package-specifier coverage already live in
      // package-contract-guardrails.test.ts and subpaths.test.ts. Keep this file
      // focused on the expensive part: can tsdown emit working bundle artifacts?
      const importResults = await Promise.all(
        bundledSmokeEntrypoints.map(async (entry) => [
          entry,
          typeof (await import(pathToFileURL(path.join(outDir, `${entry}.js`)).href)),
        ]),
      );
      expect(Object.fromEntries(importResults)).toEqual(
        Object.fromEntries(bundledSmokeEntrypoints.map((entry) => [entry, "object"])),
      );
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});
