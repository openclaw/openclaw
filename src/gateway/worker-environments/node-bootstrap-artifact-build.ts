import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants as fsConstants, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { finished, pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { valid } from "semver";
import * as tar from "tar";
import { listBundleDependencies } from "../../../scripts/lib/package-bundle-dependencies.mts";
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
  hasInstalledPackageAncestor,
  installedPackageDependencies,
  installedPackagePath,
} from "../../../scripts/lib/package-installed-dependencies.mts";
import {
  LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
} from "../../../scripts/lib/package-lifecycle-marker.mjs";
import { validateBundledPackageDependencyAlignment } from "../../../scripts/package-source-dependencies.mjs";
import { sha256File } from "../../infra/directory-durability.js";
import {
  collectPackageDistInventory,
  PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
} from "../../infra/package-dist-inventory.js";
import { composePackagePlugins } from "../../infra/package-plugin-composition.js";
import { DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS } from "../../shared/worker-bundle-archive.js";
import {
  compareWorkerBundlePaths,
  hashWorkerBundleManifest,
  WORKER_BUNDLE_ARTIFACT_MODE,
  type WorkerBundleHashEntry,
} from "../../shared/worker-bundle-hash.js";
import { MAX_WORKER_BUNDLE_ARCHIVE_BYTES } from "../../shared/worker-bundle-limits.js";
import type {
  NodeBootstrapArtifactOptions,
  NodeBootstrapArtifact,
} from "./node-bootstrap-artifact-contract.js";
import {
  collectNodeBootstrapDependencies,
  collectNodeBootstrapDependencyTargets,
} from "./node-bootstrap-dependencies.js";
import {
  bootstrapPath,
  readPackageManifest,
  requireRunningBuild,
  collectBootstrapFiles,
  resolvePlugins,
  type NodePackageManifest,
} from "./node-bootstrap-package.js";
import {
  copyNodeBootstrapPrebuiltArchive,
  NODE_BOOTSTRAP_PREBUILT_ARCHIVE,
} from "./node-bootstrap-prebuilt.js";
import { resolveNodeBootstrapRuntimeChunks } from "./node-bootstrap-runtime-chunks.js";

// Observe creation policy without process.umask(), whose getter mutates process-wide state.
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
  inspectImports: boolean;
  label: string;
  prefix: string;
  files: string[];
  imports: PackageDistImport[];
  packageJsons: Map<string, string>;
  patchedMcp?: { manifest: NodePackageManifest; hashes: Map<string, string> };
};

type BootstrapEntry = {
  scope: BootstrapImportScope;
} & ({ source: { root: string; relative: string } } | { contents: Buffer });

export async function prepareNodeBootstrapArtifact(
  options: NodeBootstrapArtifactOptions,
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
  const install = options.install ?? "bundle";
  const modes = await observeBootstrapModes(temporaryRoot);
  const mainScope: BootstrapImportScope = {
    inspectImports: true,
    label: packageJson.name,
    prefix: "",
    files: [],
    imports: [],
    packageJsons: new Map(),
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
  const reserveFile = (bytes: number) => {
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
    reserveFile(Buffer.byteLength(contents));
    planEntry(relative, { contents: Buffer.from(contents), scope });
  };
  const addFiles = (root: string, files: readonly string[], prefix = "", scope = mainScope) => {
    for (const relative of new Set(files)) {
      planEntry(`${prefix}${relative}`, { source: { root, relative }, scope });
    }
  };
  const readEntry = async (
    entry: BootstrapEntry,
    consume: (
      chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
      size: number,
      mode: number,
    ) => Promise<void>,
  ) => {
    if ("contents" in entry) {
      await consume([entry.contents], entry.contents.byteLength, modes[0]!);
      return;
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
      reserveFile(before.size);
      async function* chunks() {
        let remaining = before.size;
        while (remaining >= 0) {
          // Read one extra byte to detect growth without allocating for a growing file.
          const buffer = Buffer.allocUnsafe(Math.min(remaining + 1, 64 * 1024));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) {
            return;
          }
          remaining -= bytesRead;
          yield buffer.subarray(0, bytesRead);
        }
      }
      await consume(chunks(), before.size, modes[(before.mode & 0o111) !== 0 ? 1 : 0]!);
      const current = await fs.lstat(source);
      if (
        current.isSymbolicLink() ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        (await fs.realpath(source)) !== source
      ) {
        throw new Error(`Node distribution changed while packaging: ${relative}`);
      }
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
      // The node owns its filtered inventory and runtime manifest. Gateway-only
      // content metadata is finalized later and must not invalidate this archive.
      relative !== PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH &&
      !relative.startsWith("dist/worker/") &&
      !relative.startsWith("dist/worker-artifacts/") &&
      !relative.startsWith("dist/control-ui/") &&
      !externalPluginPrefixes.some((prefix) => relative.startsWith(prefix)),
  );
  // The package owns runtime helpers as well as lifecycle scripts; a second
  // launcher inventory drifts and makes every retry rebuild an invalid archive.
  const runtimeFiles = (sourcePackage.files ?? []).filter(
    (relative) =>
      (relative.startsWith("scripts/") || /\.[cm]?[jt]s$/u.test(relative)) &&
      !relative.startsWith("!") &&
      !relative.includes("*") &&
      !relative.endsWith("/"),
  );
  const { files, sourceFacts } = await resolveNodeBootstrapRuntimeChunks(
    packageRoot,
    [...runtimeFiles, ...publicFiles].filter(
      (relative) => relative !== LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
    ),
    packageJson.files ?? [],
  );
  if (!files.includes("dist/entry.js") && !files.includes("dist/entry.mjs")) {
    throw new Error(
      "Cloud bootstrap is missing its built CLI entry; run pnpm build and restart the Gateway",
    );
  }
  addFiles(packageRoot, files);
  if (install === "npm") {
    // Preserve released install/native hooks only for the explicitly selected npm adapter.
    packageJson.scripts = Object.fromEntries(
      Object.entries(packageJson.scripts ?? {}).filter(([name]) =>
        ["preinstall", "install", "postinstall"].includes(name),
      ),
    );
  } else {
    delete packageJson.scripts;
  }
  delete packageJson.devDependencies;
  for (const plugin of plugins) {
    if (plugin.bundled) {
      continue;
    }
    const pluginFiles = await collectBootstrapFiles(plugin.root, true);
    addFiles(plugin.root, pluginFiles, `dist/extensions/${plugin.id}/`);
  }

  let targets: Awaited<ReturnType<typeof collectNodeBootstrapDependencyTargets>> = [];
  if (install === "npm") {
    // Workspace bundles share root dependencies. Registry bundles carry their installed closure;
    // unbundled native packages remain npm pins for the destination's OS/CPU.
    const addBundledPackage = async (
      root: string,
      bundled: NodePackageManifest,
      prefix: string,
      workspace = false,
    ) => {
      const bundledFiles = workspace
        ? await collectPackageDistInventory(root)
        : await collectBootstrapFiles(root);
      if (bundledFiles.length === 0) {
        throw new Error(
          `Bundled node dependency ${bundled.name} needs its compiled distribution; rebuild the Gateway`,
        );
      }
      const scope: BootstrapImportScope = {
        inspectImports: true,
        label: bundled.name,
        prefix,
        files: [],
        imports: [],
        packageJsons: new Map(),
        ...(bundled.name === PATCHED_MCP_NAME
          ? { patchedMcp: { manifest: bundled, hashes: new Map<string, string>() } }
          : {}),
      };
      scopes.push(scope);
      addFiles(root, bundledFiles, prefix, scope);
      delete bundled.devDependencies;
      delete bundled.scripts;
      addGeneratedFile(`${prefix}package.json`, `${JSON.stringify(bundled, null, 2)}\n`, scope);
    };
    const addRegistryClosure = async (
      root: string,
      bundled: NodePackageManifest,
      prefix: string,
      ancestors: ReadonlyMap<string, string>,
    ): Promise<void> => {
      if (prefix.split("/").length > 64) {
        throw new Error("Node bootstrap dependency exceeds its directory depth limit");
      }
      await addBundledPackage(root, bundled, prefix);
      const destination = path.resolve(temporaryRoot, "package", prefix);
      const staged = new Map(ancestors).set(destination, root);
      for (const dependency of await installedPackageDependencies(root, bundled)) {
        if (hasInstalledPackageAncestor(destination, dependency, staged)) {
          continue;
        }
        await addRegistryClosure(
          dependency.root,
          await readPackageManifest(dependency.root),
          `${prefix}node_modules/${dependency.name}/`,
          staged,
        );
      }
    };

    const coreBundles = new Set([
      ...listBundleDependencies(sourcePackage),
      ...Object.entries(sourcePackage.dependencies ?? {})
        .filter(([, spec]) => spec.startsWith("workspace:"))
        .map(([name]) => name),
    ]);
    const bundledNames = new Set([...coreBundles, ...listBundleDependencies(packageJson)]);
    for (const name of [...bundledNames].toSorted()) {
      bootstrapPath(name);
      const owner = coreBundles.has(name)
        ? undefined
        : (plugins.find(({ packageJson: pluginJson }) =>
            listBundleDependencies(pluginJson).includes(name),
          ) ??
          plugins.find(
            ({ packageJson: pluginJson }) =>
              Object.hasOwn(pluginJson.dependencies ?? {}, name) ||
              Object.hasOwn(pluginJson.optionalDependencies ?? {}, name),
          ));
      // Source plugins execute built files but retain their source installation's dependencies.
      const installationRoot = owner?.installationRoot ?? packageRoot;
      const installed = await installedPackagePath(installationRoot, name);
      if (!installed) {
        throw new Error(
          `Bundled node dependency ${name} is missing from ${installationRoot}; install its dependencies and rebuild the Gateway`,
        );
      }
      const root = await fs.realpath(installed);
      const bundled = await readPackageManifest(root);
      if (bundled.name !== name) {
        throw new Error(`Bundled node distribution dependency identity does not match ${name}`);
      }
      // Linked workspaces share the root dependency graph.
      const workspace =
        sourcePackage.dependencies?.[name]?.startsWith("workspace:") ||
        !root.endsWith(`${path.sep}node_modules${path.sep}${name.split("/").join(path.sep)}`);
      if (workspace) {
        const dependencies = validateBundledPackageDependencyAlignment({
          bundledDependencies: bundled.dependencies,
          bundledPackageLabel: `bundled ${name}`,
          rootDependencies: packageJson.dependencies,
        });
        for (const [dependency, version] of dependencies) {
          packageJson.dependencies![dependency] = version;
        }
        delete bundled.dependencies;
      }
      const prefix = `node_modules/${name}/`;
      if (workspace) {
        await addBundledPackage(root, bundled, prefix, true);
      } else {
        await addRegistryClosure(root, bundled, prefix, new Map());
      }
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
  } else {
    const inspectedDependencies = new Set([
      ...listBundleDependencies(sourcePackage),
      ...Object.entries(sourcePackage.dependencies ?? {})
        .filter(([, spec]) => spec.startsWith("workspace:"))
        .map(([name]) => name),
    ]);
    targets = await collectNodeBootstrapDependencyTargets(packageRoot, sourcePackage);
    for (const target of targets) {
      const dependencyRoots = new Map<string, string>();
      for (const plugin of plugins) {
        for (const name of Object.keys({
          ...plugin.packageJson.dependencies,
          ...plugin.packageJson.optionalDependencies,
        })) {
          if (
            !Object.hasOwn(sourcePackage.dependencies ?? {}, name) &&
            !Object.hasOwn(sourcePackage.optionalDependencies ?? {}, name)
          ) {
            dependencyRoots.set(
              name,
              target.prefix
                ? path.join(target.root, "extensions", plugin.id)
                : plugin.installationRoot,
            );
          }
        }
      }
      for (const dependency of await collectNodeBootstrapDependencies(
        target.root,
        packageJson,
        target,
        dependencyRoots,
      )) {
        const { root, requestedName, manifest: installed } = dependency;
        if (
          !target.prefix &&
          dependency.prefix === `node_modules/${installed.name}/` &&
          packageJson.dependencies?.[installed.name]
        ) {
          packageJson.dependencies[installed.name] = installed.version;
        }
        const name = installed.name;
        const relative = path.relative(target.root, root);
        if (
          target.prefix &&
          (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        ) {
          throw new Error(`Node runtime target dependency escapes its prepared input: ${name}`);
        }
        const workspace =
          sourcePackage.dependencies?.[requestedName]?.startsWith("workspace:") ||
          // Aliases retain their requested name when flattened, but pnpm realpaths
          // can end in the manifest name. Both are installed registry layouts.
          ![requestedName, name].some((installedName) =>
            root.endsWith(
              `${path.sep}node_modules${path.sep}${installedName.split("/").join(path.sep)}`,
            ),
          );
        const dependencyFiles = workspace
          ? await collectPackageDistInventory(root)
          : await collectBootstrapFiles(root);
        if (!dependencyFiles.length) {
          throw new Error(`Node runtime dependency ${name} has no executable distribution`);
        }
        const scope: BootstrapImportScope = {
          // The built-package relative-import checker owns our workspaces/bundled patches.
          // Registry layouts retain their installed resolver graph, including optional CLI
          // files that are not ESM entrypoints; validate them through real target execution.
          inspectImports: inspectedDependencies.has(name),
          label: name,
          prefix: `${target.prefix}${dependency.prefix}`,
          files: [],
          imports: [],
          packageJsons: new Map(),
          ...(name === PATCHED_MCP_NAME
            ? { patchedMcp: { manifest: installed, hashes: new Map<string, string>() } }
            : {}),
        };
        scopes.push(scope);
        addFiles(root, dependencyFiles, scope.prefix, scope);
        const packaged = { ...installed };
        delete packaged.scripts;
        delete packaged.devDependencies;
        addGeneratedFile(
          `${scope.prefix}package.json`,
          `${JSON.stringify(packaged, null, 2)}\n`,
          scope,
        );
      }
    }
    delete packageJson.bundleDependencies;
    delete packageJson.bundledDependencies;
  }
  addGeneratedFile(
    "node-runtime.json",
    `${JSON.stringify({
      buildId,
      install,
      openclawVersion: packageJson.version,
      platforms:
        install === "bundle"
          ? targets.map(({ platform, arch, prefix }) => ({ platform, arch, prefix }))
          : [],
    })}\n`,
  );
  addGeneratedFile("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
  const inventory = [...entries.keys()].filter((entry) => entry.startsWith("dist/")).toSorted();
  addGeneratedFile(PACKAGE_DIST_INVENTORY_RELATIVE_PATH, `${JSON.stringify(inventory)}\n`);
  if (install === "npm") {
    addGeneratedFile(PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH, "pending\n");
  }
  // Inspect package metadata before JavaScript, independent of each package's file layout.
  const ordered = [...entries].toSorted(
    ([left], [right]) =>
      Number(path.posix.basename(right) === "package.json") -
        Number(path.posix.basename(left) === "package.json") ||
      compareWorkerBundlePaths(left, right),
  );
  // Root imports may legitimately reach bundled node_modules files; their own
  // dist imports still receive a separate package-relative closure check.
  mainScope.files = ordered.map(([relative]) => relative);
  for (const scope of scopes) {
    scope.files = ordered.flatMap(([relative]) =>
      relative.startsWith(scope.prefix) ? [relative.slice(scope.prefix.length)] : [],
    );
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
  const archiveHash = createHash("sha256");
  const archiveDone = pack
    ? pipeline(
        pack,
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            archiveHash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(tarballPath, { flags: "wx" }),
      )
    : Promise.resolve();
  const archiveAbort = new AbortController();
  void archiveDone.catch((error: unknown) => archiveAbort.abort(error));
  const manifest: WorkerBundleHashEntry[] = [];
  try {
    for (const [relative, entry] of ordered) {
      await readEntry(entry, async (chunks, size, mode) => {
        const importerPath = relative.slice(entry.scope.prefix.length);
        const inspected = sourceFacts.get(relative);
        const packageMetadata = path.posix.basename(relative) === "package.json";
        const includeTypeScript = entry.scope === mainScope && runtimeFiles.includes(relative);
        // Only uninspected JavaScript and package metadata need a complete source string.
        const needsText =
          packageMetadata ||
          (!inspected &&
            !entry.scope.patchedMcp &&
            (/\.[cm]?js$/u.test(importerPath) ||
              (includeTypeScript && /\.[cm]?ts$/u.test(importerPath))));
        const decoder = needsText ? new StringDecoder("utf8") : undefined;
        let text = "";
        const input = pack
          ? new tar.ReadEntry(
              new tar.Header({
                path: `package/${relative}`,
                size,
                mode,
                type: "File",
              }),
            )
          : undefined;
        if (input && pack) {
          pack.add(input);
        }
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of chunks) {
          archiveAbort.signal.throwIfAborted();
          bytes += chunk.byteLength;
          if (bytes > size) {
            throw new Error(`Node distribution changed while packaging: ${relative}`);
          }
          hash.update(chunk);
          if (decoder) {
            text += decoder.write(chunk);
          }
          if (input && !input.write(chunk)) {
            await once(input, "drain", { signal: archiveAbort.signal });
          }
        }
        if (bytes !== size) {
          throw new Error(`Node distribution changed while packaging: ${relative}`);
        }
        input?.end();
        text += decoder?.end() ?? "";
        if (packageMetadata) {
          mainScope.packageJsons.set(relative, text);
          entry.scope.packageJsons.set(importerPath, text);
        }
        const identity = {
          path: `package/${relative}`,
          size,
          mode: process.platform === "win32" ? WORKER_BUNDLE_ARTIFACT_MODE : mode,
          sha256: hash.digest("hex"),
        };
        if (entry.scope.patchedMcp) {
          entry.scope.patchedMcp.hashes.set(importerPath, identity.sha256);
        } else if (entry.scope.inspectImports) {
          entry.scope.imports.push(
            ...(inspected?.imports ??
              collectPackageDistImports({
                files: [importerPath],
                includeTypeScript,
                packageJsons: entry.scope.packageJsons,
                readText: () => text,
              })),
          );
        }
        manifest.push(identity);
        if (pack) {
          // Pack's jobs limit does not bound ReadEntry input; drain this entry first.
          await Promise.race([entryConsumed, archiveDone]);
        }
      });
    }
    for (const scope of scopes) {
      for (const [relative, text] of mainScope.packageJsons) {
        if (relative.startsWith(scope.prefix)) {
          scope.packageJsons.set(relative.slice(scope.prefix.length), text);
        }
      }
    }
    for (const scope of [...scopes, mainScope]) {
      if (!scope.inspectImports) {
        continue;
      }
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
    const runtimeManifest = Buffer.from(`${JSON.stringify(manifest)}\n`);
    reserveFile(runtimeManifest.byteLength);
    const runtimeManifestEntry = {
      path: "package/node-runtime.manifest.json",
      size: runtimeManifest.byteLength,
      mode: process.platform === "win32" ? WORKER_BUNDLE_ARTIFACT_MODE : modes[0]!,
      sha256: createHash("sha256").update(runtimeManifest).digest("hex"),
    };
    manifest.push(runtimeManifestEntry);
    if (pack) {
      const input = new tar.ReadEntry(
        new tar.Header({
          path: runtimeManifestEntry.path,
          size: runtimeManifestEntry.size,
          mode: modes[0]!,
          type: "File",
        }),
      );
      pack.add(input);
      input.end(runtimeManifest);
      await Promise.race([entryConsumed, archiveDone]);
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
  manifest.sort((left, right) => compareWorkerBundlePaths(left.path, right.path));
  if (prebuiltManifest) {
    if (hashWorkerBundleManifest(manifest) !== hashWorkerBundleManifest(prebuiltManifest)) {
      // Different builds or execution modes can select different plugin bytes. Re-enter the
      // canonical builder once with fresh source checks; never trust an adjacent checksum.
      await fs.rm(tarballPath);
      return await prepareNodeBootstrapArtifact(options, temporaryRoot, false);
    }
  }
  let tarballSha256: string;
  if (pack) {
    tarballSha256 = archiveHash.digest("hex");
  } else {
    await using handle = await fs.open(tarballPath, "r");
    tarballSha256 = (await sha256File(handle)).digest;
  }
  return {
    tarballPath,
    tarballSha256,
    tarballBytes,
    openclawVersion: packageJson.version,
    buildId,
    install,
    manifestSha256: manifest.find((entry) => entry.path === "package/node-runtime.manifest.json")!
      .sha256,
    enabledPluginIds: plugins.map(({ id }) => id).toSorted(),
  };
}
