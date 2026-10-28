import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import { collectPackageDistImportErrors } from "../../scripts/lib/package-dist-imports.mjs";
import { createPackageRuntimeUrlBuildPlugin } from "../../scripts/lib/package-runtime-url-build-plugin.mts";

const root = process.argv[2];
if (!root) {
  throw new Error("The dependency build fixture requires its temporary directory");
}
const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve("@openclaw/fs-safe/package.json"));
const nativePath = path.join(packageRoot, "dist/native.js");
const helperPath = path.join(packageRoot, "dist/windows-security-helper.js");
const entry = path.join(root, "entry.mjs");
const output = path.join(root, "output");
fs.writeFileSync(
  entry,
  [
    `export { getNativeBinding, getNativeFallbackDiagnostic } from ${JSON.stringify(nativePath)};`,
    `export { windowsSecurityHelperPath } from ${JSON.stringify(helperPath)};`,
  ].join("\n"),
);
const { bundles } = await build({
  config: false,
  entry: { entry },
  outDir: output,
  format: "esm",
  platform: "node",
  dts: false,
  deps: { alwaysBundle: () => true },
  plugins: [createPackageRuntimeUrlBuildPlugin("@openclaw/fs-safe")],
  logLevel: "silent",
  outExtensions: () => ({ js: ".mjs" }),
});
try {
  fs.symlinkSync(path.resolve("node_modules"), path.join(output, "node_modules"), "junction");
  const bundled = await import(pathToFileURL(path.join(output, "entry.mjs")).href);
  const original = await import(pathToFileURL(nativePath).href);
  const files = fs.readdirSync(output);
  process.stdout.write(
    JSON.stringify({
      helper: bundled.windowsSecurityHelperPath(),
      bundledNative: Boolean(bundled.getNativeBinding()),
      originalNative: Boolean(original.getNativeBinding()),
      manifestVersion: bundled.getNativeFallbackDiagnostic().packageVersion,
      originalManifestVersion: original.getNativeFallbackDiagnostic().packageVersion,
      packageErrors: collectPackageDistImportErrors({
        files,
        readText: (file: string) => fs.readFileSync(path.join(output, file), "utf8"),
      }),
    }),
  );
} finally {
  for (const bundle of bundles) {
    await bundle[Symbol.asyncDispose]();
  }
}
