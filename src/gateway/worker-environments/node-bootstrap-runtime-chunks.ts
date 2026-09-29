import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import {
  collectPackageDistImports,
  type PackageDistImport,
} from "../../../scripts/lib/package-dist-imports.mjs";
import { root as openFsRoot } from "../../infra/fs-safe.js";
import { collectPackageRootImports } from "../../infra/package-root-imports.js";
import { readRuntimeDependencyOwnership } from "../../infra/runtime-dependency-ownership.js";
import { NON_PACKAGED_BUNDLED_PLUGIN_DIRS } from "../../shared/non-packaged-plugin-dirs.js";
import { DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS } from "../../shared/worker-bundle-archive.js";

export async function resolveNodeBootstrapRuntimeChunks(packageRoot: string, files: string[]) {
  const ownership = readRuntimeDependencyOwnership(packageRoot);
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
      return owner?.extensions.every((id) => NON_PACKAGED_BUNDLED_PLUGIN_DIRS.has(id))
        ? [[file, owner] as const]
        : [];
    }),
  );
  const sourceFacts = new Map<string, { sha256: string; imports: PackageDistImport[] }>();
  if (privateChunks.size === 0) {
    return { files, sourceFacts };
  }
  const root = await openFsRoot(packageRoot, {
    hardlinks: "allow",
    symlinks: "reject",
    nonBlockingRead: true,
  });
  const fileSet = new Set(files);
  const imports = new Map<string, string[]>();
  // Parsing is synchronous; read one input at a time so buffers cannot multiply the byte bound.
  for (const file of files.filter((candidate) => /\.[cm]?js$/u.test(candidate))) {
    const { buffer } = await root.read(file, {
      hardlinks: "allow",
      symlinks: "reject",
      maxBytes: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS.maxExpandedBytes,
    });
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const owner = privateChunks.get(file);
    if (owner && sha256 !== owner.sha256) {
      throw new Error(`Runtime dependency ownership does not match ${file}; rebuild the Gateway`);
    }
    const source = buffer.toString("utf8");
    const fileImports = collectPackageDistImports({
      files: [file],
      readText: () => source,
    });
    sourceFacts.set(file, { sha256, imports: fileImports });
    const dependencies = new Set(fileImports.map(({ importedPath }) => importedPath));
    const resolveImport = createRequire(path.join(packageRoot, file)).resolve;
    for (const specifier of collectPackageRootImports(source)) {
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
    imports.set(file, [...dependencies]);
  }
  // Current root and shared imports override build ownership, including native require edges.
  const retained = files.filter((file) => !privateChunks.has(file));
  for (const file of retained) {
    for (const dependency of imports.get(file) ?? []) {
      if (privateChunks.delete(dependency)) {
        retained.push(dependency);
      }
    }
  }
  return { files: files.filter((file) => !privateChunks.has(file)), sourceFacts };
}
