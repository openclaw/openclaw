// Statically checks an installed plugin package's built files for
// `openclaw/plugin-sdk/*` imports that the running host no longer exports.
import fs from "node:fs/promises";
import path from "node:path";
import { walkDirectory } from "../infra/fs-safe.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { readInstalledPackageManifest } from "../infra/package-update-utils.js";

const SDK_SPECIFIER = /["'`]openclaw\/(plugin-sdk(?:\/[\w.-]+)*)["'`]/g;
const SCANNED_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
// Bounds keep this a cheap guard. Exceeding them reports "unknown", never a failure.
const MAX_SCANNED_ENTRIES = 5_000;
const MAX_SCANNED_BYTES = 64 * 1024 * 1024;

function readHostExportKeys(hostRoot: string): readonly string[] | undefined {
  const manifest = readInstalledPackageManifest(hostRoot);
  const exportsMap = manifest?.exports;
  if (!exportsMap || typeof exportsMap !== "object" || Array.isArray(exportsMap)) {
    return undefined;
  }
  return Object.keys(exportsMap);
}

function isExported(subpath: string, exportKeys: readonly string[]): boolean {
  const key = `./${subpath}`;
  return exportKeys.some((entry) => {
    const star = entry.indexOf("*");
    return star === -1
      ? entry === key
      : key.startsWith(entry.slice(0, star)) && key.endsWith(entry.slice(star + 1));
  });
}

/**
 * Lists `openclaw/plugin-sdk/*` specifiers in the package's own built JavaScript
 * (excluding nested node_modules) that the host package.json does not export.
 * Returns undefined when the host exports or the package cannot be fully scanned.
 */
export async function listUnresolvedHostSdkImports(params: {
  packageDir: string;
  hostRoot?: string;
}): Promise<string[] | undefined> {
  const hostRoot =
    params.hostRoot ??
    resolveOpenClawPackageRootSync({
      argv1: process.argv[1],
      moduleUrl: import.meta.url,
      cwd: process.cwd(),
    });
  const exportKeys = hostRoot ? readHostExportKeys(hostRoot) : undefined;
  if (!exportKeys) {
    return undefined;
  }
  try {
    const walk = await walkDirectory(params.packageDir, {
      maxEntries: MAX_SCANNED_ENTRIES,
      symlinks: "skip",
      descend: ({ name }) => name !== "node_modules" && !name.startsWith("."),
      include: ({ kind, name }) => kind === "file" && SCANNED_EXTENSIONS.has(path.extname(name)),
    });
    if (walk.truncated || walk.failedDirs.length > 0) {
      return undefined;
    }
    const unresolved = new Set<string>();
    let scannedBytes = 0;
    for (const entry of walk.entries) {
      const source = await fs.readFile(entry.path, "utf8");
      scannedBytes += source.length;
      if (scannedBytes > MAX_SCANNED_BYTES) {
        return undefined;
      }
      for (const match of source.matchAll(SDK_SPECIFIER)) {
        const subpath = match[1];
        if (subpath && !isExported(subpath, exportKeys)) {
          unresolved.add(`openclaw/${subpath}`);
        }
      }
    }
    return [...unresolved].toSorted();
  } catch {
    return undefined;
  }
}
