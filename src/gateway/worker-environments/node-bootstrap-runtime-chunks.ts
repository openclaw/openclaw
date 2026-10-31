import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import {
  collectPackageDistImports,
  preparePackageDistJavaScript,
  type PackageDistImport,
} from "../../../scripts/lib/package-dist-imports.mjs";
import { collectRootPackageExcludedExtensionDirs } from "../../../scripts/lib/root-package-bundled-plugin-excludes.mjs";
import { root as openFsRoot } from "../../infra/fs-safe.js";
import { collectPackageRootImports } from "../../infra/package-root-imports.js";
import { readRuntimeDependencyOwnership } from "../../infra/runtime-dependency-ownership.js";
import { NON_PACKAGED_BUNDLED_PLUGIN_DIRS } from "../../shared/non-packaged-plugin-dirs.js";
import { DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS } from "../../shared/worker-bundle-archive.js";

export async function resolveNodeBootstrapRuntimeChunks(
  packageRoot: string,
  files: string[],
  packageFiles: readonly string[],
  omittedPluginDirs?: ReadonlySet<string>,
) {
  const ownership = readRuntimeDependencyOwnership(packageRoot);
  const omittedPlugins =
    omittedPluginDirs ??
    new Set([
      ...NON_PACKAGED_BUNDLED_PLUGIN_DIRS,
      ...collectRootPackageExcludedExtensionDirs({ files: packageFiles }),
    ]);
  const privateChunks = new Map(
    files.flatMap((file) => {
      if (
        !file.startsWith("dist/") ||
        !/\.[cm]?js$/u.test(file) ||
        file.startsWith("dist/extensions/")
      ) {
        return [];
      }
      const owner = ownership?.chunks[file.slice("dist/".length)];
      return owner?.extensions.every((id) => omittedPlugins.has(id))
        ? [[file, owner] as const]
        : [];
    }),
  );
  const sourceFacts = new Map<string, { imports: PackageDistImport[] }>();
  if (privateChunks.size === 0) {
    return { files, sourceFacts };
  }
  const root = await openFsRoot(packageRoot, {
    hardlinks: "allow",
    symlinks: "reject",
  });
  const fileSet = new Set(files);
  const declaredFiles = new Set(packageFiles);
  const read = async (file: string) => {
    const { buffer } = await root.read(file, {
      hardlinks: "allow",
      symlinks: "reject",
      maxBytes: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS.maxExpandedBytes,
    });
    const owner = privateChunks.get(file);
    if (owner && createHash("sha256").update(buffer).digest("hex") !== owner.sha256) {
      throw new Error(`Runtime dependency ownership does not match ${file}; rebuild the Gateway`);
    }
    return buffer;
  };
  // Current root and shared imports override build ownership, including native require edges.
  const retained = new Set(files.filter((file) => !privateChunks.has(file)));
  for (const file of retained) {
    const includeTypeScript = declaredFiles.has(file) && /\.[cm]?ts$/u.test(file);
    if (!/\.[cm]?js$/u.test(file) && !includeTypeScript) {
      continue;
    }
    const source = (await read(file)).toString("utf8");
    const literalCalls = new Set<string>();
    const staticImports: string[] = [];
    const fileImports = collectPackageDistImports({
      files: [file],
      includeTypeScript,
      readText: () => source,
      onLiteralCall: (specifier) => literalCalls.add(specifier),
      onStaticImport: (specifier) => {
        staticImports.push(specifier);
      },
    });
    sourceFacts.set(file, { imports: fileImports });
    const dependencies = new Set(fileImports.map(({ importedPath }) => importedPath));
    const resolveImport = createRequire(path.join(packageRoot, file)).resolve;
    // Dist inspection deliberately skips nested dependencies; keep their existing
    // scope-aware fallback. Root bundles use the bounded statement scan instead.
    const rootImports = /(?:^|\/)node_modules\//u.test(file)
      ? collectPackageRootImports(preparePackageDistJavaScript(file, source))
      : new Set([...staticImports, ...literalCalls]);
    // False positives only retain extra chunks; required-import validation stays exact.
    for (const specifier of rootImports) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const specifierPath = specifier.replace(/[?#].*$/u, "");
      const direct = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifierPath));
      if (fileSet.has(direct) && dependencies.has(direct)) {
        continue;
      }
      try {
        dependencies.add(
          path.relative(packageRoot, resolveImport(specifierPath)).split(path.sep).join("/"),
        );
      } catch {
        // The archive's closure check owns missing relative imports.
      }
    }
    for (const dependency of dependencies) {
      if (privateChunks.has(dependency)) {
        retained.add(dependency);
      }
    }
  }
  // Omitted bytes must still match their build ownership, but need no import AST.
  for (const file of privateChunks.keys()) {
    if (!retained.has(file)) {
      await read(file);
    }
  }
  return { files: files.filter((file) => retained.has(file)), sourceFacts };
}
