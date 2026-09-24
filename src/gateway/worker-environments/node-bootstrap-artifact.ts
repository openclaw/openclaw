import { createHash } from "node:crypto";
import { constants as fsConstants, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { finished, pipeline } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import { valid } from "semver";
import * as tar from "tar";
import {
  collectPatchedMcpArtifactErrors,
  PATCHED_MCP_NAME,
} from "../../../scripts/lib/package-bundled-mcp.mjs";
import {
  collectPackageDistImportErrors,
  collectPackageDistImports,
  type PackageDistImport,
} from "../../../scripts/lib/package-dist-imports.mjs";
import {
  LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
} from "../../../scripts/lib/package-lifecycle-marker.mjs";
import { validateBundledPackageDependencyAlignment } from "../../../scripts/package-source-dependencies.mjs";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { sha256File } from "../../infra/directory-durability.js";
import { readFileHandleBounded } from "../../infra/fs-safe-advanced.js";
import { walkDirectory } from "../../infra/fs-safe.js";
import {
  collectPackageDistInventory,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
} from "../../infra/package-dist-inventory.js";
import {
  composePackagePlugins,
  type DistributionPackageManifest,
} from "../../infra/package-plugin-composition.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  readWorkerBundleArchiveManifest,
} from "../../shared/worker-bundle-archive.js";
import {
  compareWorkerBundlePaths,
  hashWorkerBundleManifest,
  WORKER_BUNDLE_ARTIFACT_MODE,
  type WorkerBundleHashEntry,
} from "../../shared/worker-bundle-hash.js";
import { MAX_WORKER_BUNDLE_ARCHIVE_BYTES } from "../../shared/worker-bundle-limits.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import {
  copyNodeBootstrapPrebuiltArchive,
  NODE_BOOTSTRAP_PREBUILT_ARCHIVE,
} from "./node-bootstrap-prebuilt.js";
import { resolveNodeBootstrapRuntimeChunks } from "./node-bootstrap-runtime-chunks.js";

const BOOTSTRAP_LAUNCHER_FILES = [
  "openclaw.mjs",
  "node-version.mjs",
  "node-sqlite.mjs",
  "node-runtime-update.mjs",
  "node-runtime-recovery.mjs",
  "cli-root-options.mjs",
  "gateway-run-argv.mjs",
  "gateway-shutdown-budget.mjs",
  "node-host-launcher.mjs",
];
const READ_CONCURRENCY = 16;
const IGNORED_PLUGIN_DIRECTORIES = new Set(["node_modules", "src", "test", "tests"]);
const METADATA_KEYS = [
  "name",
  "version",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
] as const;

type NodePackageManifest = DistributionPackageManifest & {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bundleDependencies?: string[];
  bundledDependencies?: string[];
  openclaw?: { extensions?: string[]; runtimeExtensions?: string[] };
};

export type NodeBootstrapArtifact = Readonly<{
  tarballPath: string;
  tarballSha256: string;
  tarballBytes: number;
  openclawVersion: string;
  buildId: string;
  enabledPluginIds: readonly string[];
}>;

type ArtifactOptions = {
  packageRoot: string;
  runningBuildId: string | null;
  plugins: readonly { id: string; root: string }[];
};

function bootstrapPath(value: string): string {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe node distribution path: ${value}`);
  }
  return value;
}

async function readPackageManifest(root: string): Promise<NodePackageManifest> {
  const value = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  ) as NodePackageManifest; // SAFETY: trusted installation metadata; identity, pins and import closure are checked before publication.
  if (!value.name || valid(value.version) !== value.version) {
    throw new Error("Node distribution requires a named package with an exact version");
  }
  return value;
}

function requireRunningBuild(options: ArtifactOptions, text: string, version: string): string {
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

// Observe creation policy without process.umask(), whose getter mutates process-wide state.
// Probe again before publication: a changed policy must not silently change archive modes.
async function observeBootstrapModes(root: string): Promise<readonly number[]> {
  const modes: number[] = [];
  for (const requested of [0o644, 0o755]) {
    const probe = path.join(root, `.mode-${requested.toString(8)}`);
    const handle = await fs.open(probe, "wx", requested);
    try {
      modes.push((await handle.stat()).mode & 0o777);
    } finally {
      await handle.close();
      await fs.rm(probe);
    }
  }
  return modes;
}

type BootstrapImportScope = {
  label: string;
  prefix: string;
  files: string[];
  imports: PackageDistImport[];
  patchedMcp?: { manifest: NodePackageManifest; hashes: Map<string, string> };
};

type BootstrapEntry = {
  scope: BootstrapImportScope;
} & ({ source: { root: string; relative: string } } | { contents: Buffer });

async function collectInstalledBundledFiles(root: string): Promise<string[]> {
  const included = ({ name }: { name: string }) => name !== "node_modules" && !name.startsWith(".");
  const { entries, failedDirs, truncated } = await walkDirectory(root, {
    maxEntries: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS.maxEntries,
    symlinks: "include",
    include: included,
    descend: (entry) => {
      if (entry.depth >= 64) {
        throw new Error("Node bootstrap dependency exceeds its directory depth limit");
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
    if (entry.kind === "directory" || entry.relativePath === "package.json") {
      return [];
    }
    if (entry.kind !== "file") {
      throw new Error(`Unsafe bundled node distribution path: ${entry.relativePath}`);
    }
    return [entry.relativePath.split(path.sep).join("/")];
  });
}

async function resolvePlugins(options: ArtifactOptions, packageRoot: string) {
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
      if (requestedRoot === sourceRoot) {
        const sourcePackage = await readPackageManifest(sourceRoot);
        if (METADATA_KEYS.some((key) => !isDeepStrictEqual(packageJson[key], sourcePackage[key]))) {
          throw new Error(
            `Built plugin ${id} does not match source metadata; rebuild and restart the Gateway`,
          );
        }
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
      return { id, root: builtRoot, packageJson, bundled: builtRoot === bundledRoot };
    }),
  );
}

async function prepareNodeBootstrapArtifact(
  options: ArtifactOptions,
  temporaryRoot: string,
  usePrebuilt = true,
): Promise<NodeBootstrapArtifact> {
  const packageRoot = await fs.realpath(options.packageRoot);
  const sourcePackage = await readPackageManifest(packageRoot);
  if (sourcePackage.name !== "openclaw") {
    throw new Error("Node bootstrap requires the running OpenClaw package root");
  }
  const buildInfoPath = path.join(packageRoot, "dist", "build-info.json");
  const buildInfo = await fs.readFile(buildInfoPath, "utf8").catch((cause: unknown) => {
    throw new Error(
      "Cloud bootstrap requires a built Gateway; run pnpm build and restart the Gateway before provisioning",
      { cause },
    );
  });
  const buildId = requireRunningBuild(options, buildInfo, sourcePackage.version);
  const plugins = await resolvePlugins(options, packageRoot);
  const packageJson = composePackagePlugins(sourcePackage, plugins);
  const modes = await observeBootstrapModes(temporaryRoot);
  const mainScope: BootstrapImportScope = {
    label: packageJson.name,
    prefix: "",
    files: [],
    imports: [],
  };
  const scopes: BootstrapImportScope[] = [];
  const entries = new Map<string, BootstrapEntry>();
  const planEntry = (relative: string, entry: BootstrapEntry) => {
    bootstrapPath(relative);
    entries.set(relative, entry);
    if (entries.size > DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS.maxEntries) {
      throw new Error("Node bootstrap distribution exceeds its artifact limits");
    }
  };
  let expandedBytes = 0;
  let reservedEntries = 0;
  const reserveFile = (relative: string, bytes: number) => {
    bootstrapPath(relative);
    expandedBytes += bytes;
    reservedEntries += 1;
    if (
      reservedEntries > DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS.maxEntries ||
      expandedBytes > DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS.maxExpandedBytes
    ) {
      throw new Error("Node bootstrap distribution exceeds its artifact limits");
    }
  };
  const addGeneratedFile = (relative: string, contents: string, scope = mainScope) => {
    reserveFile(relative, Buffer.byteLength(contents));
    planEntry(relative, { contents: Buffer.from(contents), scope });
  };
  const addFiles = (root: string, files: readonly string[], prefix = "", scope = mainScope) => {
    for (const relative of new Set(files)) {
      bootstrapPath(relative);
      planEntry(`${prefix}${relative}`, { source: { root, relative }, scope });
    }
  };
  const readEntry = async (destination: string, entry: BootstrapEntry) => {
    if ("contents" in entry) {
      return { contents: entry.contents, mode: modes[0]! };
    }
    const { root, relative } = entry.source;
    const source = path.join(root, relative);
    if ((await fs.realpath(source)) !== source) {
      throw new Error(`Node distribution cannot contain symbolic links: ${relative}`);
    }
    const handle = await fs.open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new Error(`Invalid node distribution file: ${relative}`);
      }
      reserveFile(destination, before.size);
      const contents = await readFileHandleBounded(handle, before.size);
      const current = await fs.lstat(source);
      if (
        contents.byteLength !== before.size ||
        current.isSymbolicLink() ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        (await fs.realpath(source)) !== source
      ) {
        throw new Error(`Node distribution changed while packaging: ${relative}`);
      }
      return { contents, mode: modes[(before.mode & 0o111) !== 0 ? 1 : 0]! };
    } finally {
      await handle.close();
    }
  };

  const externalPluginPrefixes = plugins
    .filter((plugin) => !plugin.bundled)
    .map(({ id }) => `dist/extensions/${id}/`);
  const publicFiles = (
    await collectPackageDistInventory(packageRoot, { packageManifest: packageJson })
  ).filter(
    // The Gateway serves Control UI assets; nodes install their worker bundle separately.
    // Neither belongs in the node runtime's packaging, validation, or download work.
    (relative) =>
      !relative.startsWith("dist/worker/") &&
      !relative.startsWith("dist/control-ui/") &&
      !externalPluginPrefixes.some((prefix) => relative.startsWith(prefix)),
  );
  const scripts = (sourcePackage.files ?? []).filter(
    (relative) =>
      relative.startsWith("scripts/") && !relative.includes("*") && !relative.endsWith("/"),
  );
  const { files, sourceFacts } = await resolveNodeBootstrapRuntimeChunks(
    packageRoot,
    [...BOOTSTRAP_LAUNCHER_FILES, ...publicFiles, ...scripts].filter(
      (relative) => relative !== LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
    ),
  );
  if (!files.includes("dist/entry.js") && !files.includes("dist/entry.mjs")) {
    throw new Error(
      "Cloud bootstrap is missing its built CLI entry; run pnpm build and restart the Gateway",
    );
  }
  addFiles(packageRoot, files);
  // Keep real install guards/pruning, but source-only prepare/prepack commands must not run on a node.
  packageJson.scripts = Object.fromEntries(
    Object.entries(packageJson.scripts ?? {}).filter(([name]) =>
      ["preinstall", "install", "postinstall"].includes(name),
    ),
  );
  delete packageJson.devDependencies;
  for (const plugin of plugins) {
    if (plugin.bundled) {
      continue;
    }
    const pluginFiles: string[] = [];
    const visit = async (directory: string, relativeRoot = ""): Promise<void> => {
      for (const child of await fs.readdir(directory, { withFileTypes: true })) {
        if (child.name.startsWith(".") || IGNORED_PLUGIN_DIRECTORIES.has(child.name)) {
          continue;
        }
        const relative = relativeRoot ? `${relativeRoot}/${child.name}` : child.name;
        if (relative.split("/").length > 64) {
          throw new Error("Node bootstrap plugin exceeds its directory depth limit");
        }
        if (child.isDirectory()) {
          await visit(path.join(directory, child.name), relative);
        } else if (/\.(?:[cm]?js|json|wasm)$/u.test(child.name)) {
          pluginFiles.push(relative);
        }
      }
    };
    await visit(plugin.root);
    addFiles(plugin.root, pluginFiles, `dist/extensions/${plugin.id}/`);
  }

  // Only declared bundled/workspace packages cross as JavaScript artifacts. Native dependencies
  // remain exact npm pins, so the destination chooses its own OS/CPU optional packages.
  const bundledNames = new Set([
    ...(packageJson.bundleDependencies ?? packageJson.bundledDependencies ?? []),
    ...Object.entries(packageJson.dependencies ?? {})
      .filter(([, spec]) => spec.startsWith("workspace:"))
      .map(([name]) => name),
  ]);
  for (const name of [...bundledNames].toSorted()) {
    bootstrapPath(name);
    const root = await fs.realpath(path.join(packageRoot, "node_modules", name));
    const bundled = await readPackageManifest(root);
    if (bundled.name !== name) {
      throw new Error(`Bundled node distribution dependency identity does not match ${name}`);
    }
    const dependencies = validateBundledPackageDependencyAlignment({
      bundledDependencies: bundled.dependencies,
      bundledPackageLabel: `bundled ${name}`,
      rootDependencies: packageJson.dependencies,
    });
    for (const [dependency, version] of dependencies) {
      packageJson.dependencies![dependency] = version;
    }
    // Linked workspaces can carry source and private files; installed npm bundles already
    // own their published layout, including compiled directories and non-JavaScript assets.
    const workspace =
      sourcePackage.dependencies?.[name]?.startsWith("workspace:") ||
      !root.endsWith(`${path.sep}node_modules${path.sep}${name.split("/").join(path.sep)}`);
    const bundledFiles = workspace
      ? await collectPackageDistInventory(root)
      : await collectInstalledBundledFiles(root);
    if (bundledFiles.length === 0) {
      throw new Error(
        `Bundled node dependency ${name} needs its compiled distribution; rebuild the Gateway`,
      );
    }
    const scope: BootstrapImportScope = {
      label: name,
      prefix: `node_modules/${name}/`,
      files: [],
      imports: [],
      ...(name === PATCHED_MCP_NAME
        ? { patchedMcp: { manifest: bundled, hashes: new Map<string, string>() } }
        : {}),
    };
    scopes.push(scope);
    addFiles(root, bundledFiles, scope.prefix, scope);
    delete bundled.dependencies;
    delete bundled.devDependencies;
    delete bundled.scripts;
    addGeneratedFile(
      `node_modules/${name}/package.json`,
      `${JSON.stringify(bundled, null, 2)}\n`,
      scope,
    );
    packageJson.dependencies![name] = bundled.version;
  }
  packageJson.bundleDependencies = [...bundledNames].toSorted();
  delete packageJson.bundledDependencies;
  for (const [name, spec] of Object.entries({
    ...packageJson.optionalDependencies,
    ...packageJson.dependencies,
  })) {
    if (valid(spec) !== spec) {
      throw new Error(`Node distribution requires an exact dependency pin: ${name}@${spec}`);
    }
  }
  addGeneratedFile("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
  const inventory = [...entries.keys()].filter((entry) => entry.startsWith("dist/")).toSorted();
  addGeneratedFile(PACKAGE_DIST_INVENTORY_RELATIVE_PATH, `${JSON.stringify(inventory)}\n`);
  addGeneratedFile(PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH, "pending\n");
  const ordered = [...entries].toSorted(([left], [right]) => compareWorkerBundlePaths(left, right));
  // Root imports may legitimately reach bundled node_modules files; their own
  // dist imports still receive a separate package-relative closure check.
  mainScope.files = ordered.map(([relative]) => relative);
  for (const [relative, entry] of ordered) {
    if (entry.scope !== mainScope) {
      entry.scope.files.push(relative.slice(entry.scope.prefix.length));
    }
  }
  const tarballPath = path.join(temporaryRoot, NODE_BOOTSTRAP_PREBUILT_ARCHIVE);
  const prebuiltManifest = usePrebuilt
    ? await copyNodeBootstrapPrebuiltArchive(packageRoot, temporaryRoot)
    : undefined;
  let entryConsumed = Promise.resolve();
  const pack = prebuiltManifest
    ? undefined
    : new tar.Pack({
        gzip: true,
        noMtime: true,
        portable: true,
        strict: true,
        onWriteEntry(entry) {
          entryConsumed = finished(entry, { readable: true, writable: false, cleanup: true });
          void entryConsumed.catch(() => undefined);
        },
      });
  const archiveDone = pack
    ? pipeline(pack, createWriteStream(tarballPath, { flags: "wx" }))
    : Promise.resolve();
  // Observe output errors immediately, but join the pipeline after in-flight reads drain.
  void archiveDone.catch(() => undefined);
  const manifest: WorkerBundleHashEntry[] = [];
  try {
    // One batch holds at most 16 source buffers under the existing expanded-byte budget.
    // Pack's jobs limit does not bound ReadEntry input, so consume each output entry below.
    for (let offset = 0; offset < ordered.length; offset += READ_CONCURRENCY) {
      const batch = ordered.slice(offset, offset + READ_CONCURRENCY);
      const read = await runTasksWithConcurrency({
        tasks: batch.map(
          ([relative, entry]) =>
            () =>
              readEntry(relative, entry),
        ),
        limit: READ_CONCURRENCY,
        errorMode: "stop",
      });
      if (read.hasError) {
        throw read.firstError;
      }
      for (let index = 0; index < batch.length; index += 1) {
        const [relative, entry] = batch[index]!;
        const { contents, mode } = read.results[index]!;
        const importerPath = relative.slice(entry.scope.prefix.length);
        const identity = {
          path: `package/${relative}`,
          size: contents.byteLength,
          mode: process.platform === "win32" ? WORKER_BUNDLE_ARTIFACT_MODE : mode,
          sha256: createHash("sha256").update(contents).digest("hex"),
        };
        const inspected = sourceFacts.get(relative);
        if (inspected && identity.sha256 !== inspected.sha256) {
          throw new Error(`Node distribution changed after import inspection: ${relative}`);
        }
        if (entry.scope.patchedMcp) {
          entry.scope.patchedMcp.hashes.set(importerPath, identity.sha256);
        } else {
          entry.scope.imports.push(
            ...(inspected?.imports ??
              collectPackageDistImports({
                files: [importerPath],
                readText: () => contents.toString("utf8"),
              })),
          );
        }
        manifest.push(identity);
        if (!pack) {
          continue;
        }
        const input = new tar.ReadEntry(
          new tar.Header({
            path: identity.path,
            size: identity.size,
            mode,
            type: "File",
          }),
        );
        pack.add(input);
        input.end(contents);
        // Wait for tar's output entry, not merely the input buffer, before feeding another.
        await Promise.race([entryConsumed, archiveDone]);
      }
    }
    for (const scope of [...scopes, mainScope]) {
      const errors = scope.patchedMcp
        ? collectPatchedMcpArtifactErrors({
            manifest: scope.patchedMcp.manifest,
            files: new Set(scope.files),
            sha256: (file) => scope.patchedMcp?.hashes.get(file),
          })
        : collectPackageDistImportErrors(scope);
      if (errors.length > 0) {
        throw new Error(
          `Node distribution ${scope.label} ${scope.patchedMcp ? "has an invalid patched dependency" : "has an incomplete built import closure"}; rebuild and restart the Gateway: ${errors.slice(0, 5).join("; ")}`,
        );
      }
    }
    if (!isDeepStrictEqual(await observeBootstrapModes(temporaryRoot), modes)) {
      throw new Error("Node bootstrap file creation policy changed while packaging");
    }
    if (
      (await fs.readFile(buildInfoPath, "utf8")) !== buildInfo ||
      !isDeepStrictEqual(await readPackageManifest(packageRoot), sourcePackage)
    ) {
      throw new Error(
        "Gateway build changed while preparing cloud bootstrap; restart the Gateway and retry",
      );
    }
    pack?.end();
    await archiveDone;
  } catch (error) {
    // Minipass needs an error event; argumentless destroy does not settle Node's pipeline.
    pack?.destroy(
      error instanceof Error ? error : new Error("Node bootstrap archive failed", { cause: error }),
    );
    pack?.zip?.destroy();
    await archiveDone.catch(() => undefined);
    throw error;
  }
  const tarballBytes = (await fs.stat(tarballPath)).size;
  if (tarballBytes > MAX_WORKER_BUNDLE_ARCHIVE_BYTES) {
    throw new Error("Node bootstrap archive exceeds the transfer limit");
  }
  const archiveManifest =
    prebuiltManifest ??
    (await readWorkerBundleArchiveManifest(tarballPath, DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS));
  if (hashWorkerBundleManifest(manifest) !== hashWorkerBundleManifest(archiveManifest)) {
    if (prebuiltManifest) {
      // Different builds or execution modes can select different plugin bytes. Re-enter the
      // canonical builder once with fresh source checks; never trust an adjacent checksum.
      await fs.rm(tarballPath);
      return await prepareNodeBootstrapArtifact(options, temporaryRoot, false);
    }
    throw new Error("Node bootstrap archive does not match the verified distribution");
  }
  await using handle = await fs.open(tarballPath, "r");
  const { digest: tarballSha256 } = await sha256File(handle);
  return Object.freeze({
    tarballPath,
    tarballSha256,
    tarballBytes,
    openclawVersion: packageJson.version,
    buildId,
    enabledPluginIds: Object.freeze(plugins.map(({ id }) => id).toSorted()),
  });
}

/** Owns one immutable deployment artifact for this Gateway process, never the live installation. */
export function createNodeBootstrapArtifactProvider(options: ArtifactOptions) {
  let prepared: Promise<NodeBootstrapArtifact> | undefined;
  let temporaryRoot: string | undefined;
  let closed = false;
  const consumers = new Map<AbortSignal, Promise<void>>();
  return {
    async prepare(signal?: AbortSignal): Promise<NodeBootstrapArtifact> {
      signal?.throwIfAborted();
      if (closed) {
        throw new Error("Node bootstrap artifact provider is closed");
      }
      // Assign the shared promise before synchronous scratch-root failures can clear it.
      prepared ??= Promise.resolve().then(async () => {
        try {
          temporaryRoot = await fs.mkdtemp(
            path.join(resolvePreferredOpenClawTmpDir(), "openclaw-node-runtime-"),
          );
          if (closed) {
            throw new Error("Node bootstrap artifact provider is closed");
          }
          const artifact = await prepareNodeBootstrapArtifact(options, temporaryRoot);
          if (closed) {
            throw new Error("Node bootstrap artifact provider is closed");
          }
          return artifact;
        } catch (error) {
          if (temporaryRoot) {
            await fs.rm(temporaryRoot, { recursive: true, force: true });
          }
          temporaryRoot = undefined;
          prepared = undefined;
          throw error;
        }
      });
      // Cancellation releases this consumer; process shutdown still drains the shared producer.
      const artifact = await racePromiseWithAbortSignal(prepared, signal);
      signal?.throwIfAborted();
      if (closed) {
        throw new Error("Node bootstrap artifact provider is closed");
      }
      // A registry reload retires the producer, but an admitted enrollment still owns
      // its artifact until that enrollment's authority closes.
      if (signal && !consumers.has(signal)) {
        consumers.set(
          signal,
          new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                consumers.delete(signal);
                resolve();
              },
              { once: true },
            );
          }),
        );
      }
      return artifact;
    },
    async close(): Promise<void> {
      closed = true;
      await prepared?.catch(() => undefined);
      await Promise.all(consumers.values());
      if (temporaryRoot) {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
        temporaryRoot = undefined;
      }
    },
  };
}
