import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";

/** PDF.js resolves fonts, CMaps and image decoders by filename, not hashed imports. */
export function controlUiPdfAssetsPlugin(): Plugin {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  ) {
    throw new Error("PDF.js package version is unavailable");
  }
  const prefix = `assets/pdfjs-${manifest.version}/`;
  const files = new Map<string, string>([
    [`${prefix}LICENSE`, path.join(root, "LICENSE")],
    [`${prefix}pdf.worker.min.js`, path.join(root, "build/pdf.worker.min.mjs")],
  ]);
  for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
    for (const name of fs.readdirSync(path.join(root, directory))) {
      if (/\.(?:bcmap|pfb|ttf|wasm|js|icc)$/.test(name) || name.startsWith("LICENSE")) {
        files.set(`${prefix}${directory}/${name}`, path.join(root, directory, name));
      }
    }
  }
  return {
    name: "control-ui-pdf-assets",
    generateBundle() {
      for (const [fileName, filename] of files) {
        this.emitFile({ type: "asset", fileName, source: fs.readFileSync(filename) });
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        const assetPath = pathname.slice(server.config.base.length);
        const filename = files.get(assetPath);
        if (!filename) {
          next();
          return;
        }
        res.setHeader(
          "Content-Type",
          assetPath.endsWith(".js")
            ? "text/javascript"
            : assetPath.endsWith(".wasm")
              ? "application/wasm"
              : "application/octet-stream",
        );
        res.end(fs.readFileSync(filename));
      });
    },
  };
}
