import fs from "node:fs";
import path from "node:path";
import { build } from "tsdown";

export async function prepareCopiedSourceModules(root: string, entries: string[]) {
  const { bundles } = await build({
    config: false,
    cwd: root,
    root,
    entry: entries,
    outDir: root,
    unbundle: true,
    format: "esm",
    platform: "node",
    dts: false,
    clean: false,
    treeshake: false,
    deps: {
      alwaysBundle: (id) =>
        id.startsWith("@openclaw/") &&
        !id.startsWith("@openclaw/fs-safe") &&
        !id.startsWith("@openclaw/proxyline"),
      neverBundle(id, importer) {
        if (/^(?:vitest|vite|tsdown|rolldown|esbuild|typescript)(?:\/|$)/u.test(id)) {
          return true;
        }
        if (!importer || !id.startsWith(".")) {
          return false;
        }
        const target = path.resolve(path.dirname(importer), id);
        // Sparse wrapper fixtures intentionally omit lazy application modules.
        // Leave those imports unresolved; taking that branch must still fail.
        return ![target, target.replace(/\.js$/u, ".ts"), target.replace(/\.mjs$/u, ".mts")].some(
          (candidate) => fs.existsSync(candidate),
        );
      },
    },
    outExtensions: () => ({ js: ".js" }),
    outputOptions: { entryFileNames: "[name].js", chunkFileNames: "[name].js" },
    logLevel: "silent",
  });
  for (const bundle of bundles) {
    await bundle[Symbol.asyncDispose]();
  }
}
