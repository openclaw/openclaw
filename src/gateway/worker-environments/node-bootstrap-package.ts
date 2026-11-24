import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { valid } from "semver";
import { hasErrnoCode } from "../../infra/errno.js";
import { walkDirectory } from "../../infra/fs-safe.js";
import type { DistributionPackageManifest } from "../../infra/package-plugin-composition.js";
import { DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS } from "../../shared/worker-bundle-archive.js";
import type { NodeBootstrapArtifactOptions } from "./node-bootstrap-artifact-contract.js";

const IGNORED_PLUGIN_DIRECTORIES = new Set(["node_modules", "src", "test", "tests"]);
// Shared runtime chunks that the plugin npm build publishes under this hidden dist
// directory (see scripts/lib/plugin-npm-runtime-build.mts chunkFileNames).
const PLUGIN_DIST_SHARED_CHUNK_PREFIX = "dist/.setup";
const METADATA_KEYS = [
  "name",
  "version",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
] as const;

export type NodePackageManifest = DistributionPackageManifest & {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  openclaw?: { extensions?: string[]; runtimeExtensions?: string[] };
};

export function bootstrapPath(value: string): string {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    /[\r\n]/u.test(value) ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe node distribution path: ${value}`);
  }
  return value;
}

export async function readPackageManifest(root: string): Promise<NodePackageManifest> {
  const value = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  ) as NodePackageManifest; // SAFETY: trusted installation metadata; identity, pins and import closure are checked before publication.
  if (!value.name || valid(value.version) !== value.version) {
    throw new Error("Node distribution requires a named package with an exact version");
  }
  return value;
}

export async function collectBootstrapFiles(root: string, plugin = false): Promise<string[]> {
  // Published plugins alone use dist/.setup; private descendants remain excluded.
  // Registry packages can ship implementation modules below src/node_modules.
  const included = ({ name, relativePath }: { name: string; relativePath: string }) =>
    (plugin && relativePath.split(path.sep).join("/") === PLUGIN_DIST_SHARED_CHUNK_PREFIX) ||
    (!name.startsWith(".") &&
      !(plugin ? IGNORED_PLUGIN_DIRECTORIES.has(name) : relativePath === "node_modules"));
  const { entries, failedDirs, truncated } = await walkDirectory(root, {
    maxEntries: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS.maxEntries,
    symlinks: "include",
    include: included,
    descend: (entry) => {
      if (entry.depth >= 64) {
        throw new Error(
          `Node bootstrap ${plugin ? "plugin" : "dependency"} exceeds its directory depth limit`,
        );
      }
      return included(entry);
    },
  });
  if (failedDirs.length > 0) {
    throw failedDirs[0]!.error;
  }
  if (truncated) {
    throw new Error("Node bootstrap distribution exceeds its artifact limits");
  }
  return entries.flatMap((entry) => {
    if (
      entry.kind === "directory" ||
      (plugin
        ? !/\.(?:[cm]?js|json|wasm)$/u.test(entry.name)
        : entry.relativePath === "package.json")
    ) {
      return [];
    }
    if (entry.kind !== "file") {
      throw new Error(`Unsafe bundled node distribution path: ${entry.relativePath}`);
    }
    return [entry.relativePath.split(path.sep).join("/")];
  });
}

export async function resolvePlugins(options: NodeBootstrapArtifactOptions, packageRoot: string) {
  const ids = new Set<string>();
  return await Promise.all(
    options.plugins.map(async ({ id, root }) => {
      if (!/^[a-z0-9][a-z0-9_-]*$/u.test(id) || ids.has(id)) {
        throw new Error(`Invalid or duplicate node bootstrap plugin: ${id}`);
      }
      ids.add(id);
      const requestedRoot = await fs.realpath(root);
      const sourceRoot = path.join(packageRoot, "extensions", id);
      const bundledRoot = path.join(packageRoot, "dist", "extensions", id);
      const builtRoot = requestedRoot === sourceRoot ? bundledRoot : requestedRoot;
      const packageJson = await readPackageManifest(builtRoot);
      // Built-entry qualification retains the source installation as dependency owner.
      // Published packages have no source tree and resolve from their installed built root.
      const sourcePackage =
        builtRoot === bundledRoot
          ? await readPackageManifest(sourceRoot).catch((error: unknown) => {
              if (requestedRoot === bundledRoot && hasErrnoCode(error, "ENOENT")) {
                return undefined;
              }
              throw error;
            })
          : undefined;
      if (
        sourcePackage &&
        METADATA_KEYS.some((key) => !isDeepStrictEqual(packageJson[key], sourcePackage[key]))
      ) {
        throw new Error(
          `Built plugin ${id} does not match source metadata; rebuild and restart the Gateway`,
        );
      }
      const manifest = JSON.parse(
        await fs.readFile(path.join(builtRoot, "openclaw.plugin.json"), "utf8"),
      ) as { id?: unknown }; // SAFETY: the unknown id is checked against the trusted registry below.
      if (manifest.id !== id) {
        throw new Error(`Node bootstrap plugin identity does not match ${id}`);
      }
      const entries = packageJson.openclaw?.runtimeExtensions ?? packageJson.openclaw?.extensions;
      if (!entries?.length) {
        throw new Error(`Node bootstrap plugin ${id} has no runtime entry`);
      }
      for (const entry of entries) {
        const relative = bootstrapPath(entry.replace(/^\.\//u, "").replace(/\.ts$/u, ".js"));
        await fs.access(path.join(builtRoot, relative));
      }
      return {
        id,
        root: builtRoot,
        installationRoot: sourcePackage ? sourceRoot : requestedRoot,
        packageJson,
        bundled: builtRoot === bundledRoot,
      };
    }),
  );
}

export function requireRunningBuild(
  options: NodeBootstrapArtifactOptions,
  text: string,
  version: string,
): string {
  // SAFETY: fields remain unknown until matched against the process's immutable build identity below.
  const info = JSON.parse(text) as { buildId?: unknown; version?: unknown };
  if (
    !options.runningBuildId ||
    info.buildId !== options.runningBuildId ||
    info.version !== version
  ) {
    throw new Error(
      "Cloud bootstrap requires the running Gateway build; run pnpm build and restart the Gateway before provisioning",
    );
  }
  return options.runningBuildId;
}
