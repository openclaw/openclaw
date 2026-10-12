import fs from "node:fs/promises";
import path from "node:path";
import { assertDirectoryIdentitySync, readDirectoryIdentity } from "@openclaw/fs-safe/advanced";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { root as openRoot } from "./fs-safe.js";
import { tryReadJson } from "./json-files.js";
import { parseRegistryNpmSpec } from "./npm-registry-spec.js";
import { isPackageUpdateRecoveryArtifactName } from "./package-update-backup-paths.js";
import { hasNodeErrorCode, isPathInside, isPathStrictlyInside } from "./path-guards.js";
import { ignoreMissingUpdateCandidateFile } from "./update-candidate-files.js";
import type { UpdateCandidatePluginCodeLink } from "./update-candidate-plugin-code-links.js";
import { copyUpdateCandidatePluginFiles } from "./update-candidate-plugin-file.js";
import {
  withUpdateCandidatePluginFileHashing,
  type UpdateCandidatePluginFileHasher,
} from "./update-candidate-plugin-hash.js";
import { runUpdateCandidatePluginTasks } from "./update-candidate-plugin-tasks.js";
import {
  assertUpdateCandidatePluginEntryStat,
  ignoreUnresolvedPluginLink,
  isUpdateCandidateHostLauncher,
  publishUpdateCandidatePluginTreeLinks,
  resolveUpdateCandidatePluginTreeTargets,
  verifyUpdateCandidatePluginTree,
} from "./update-candidate-plugin-tree-links.js";
import type {
  UpdateCandidatePluginEntry,
  UpdateCandidatePluginTreePlan,
} from "./update-candidate-plugin-tree-schema.js";
import { createRuntimePathLookup } from "./update-runtime-path-index.js";
import {
  readRuntimeModulesManifest,
  relocateRuntimeSymlink,
  resolveRuntimeFileRelocator,
  type RuntimeRelocation,
} from "./update-runtime-relocation.js";
import { isGitRuntimeStagingName } from "./update-runtime-staging.js";

async function dependencyOwner(
  target: string,
  withinRetainedHost = false,
  retainedHost?: { root: string; moduleOnlyRoots: Set<string> },
): Promise<string> {
  // A pnpm package resolves dependencies beside its package directory. Preserve
  // that Node lookup ancestry, including scoped packages and nested installs.
  const parts = target.split(path.sep);
  const store = parts.indexOf(".pnpm");
  if (store >= 0 && !withinRetainedHost) {
    return parts.slice(0, store + 1).join(path.sep);
  }
  const modules = parts.indexOf("node_modules");
  if (modules >= 0 && !withinRetainedHost) {
    return parts.slice(0, modules + 1).join(path.sep);
  }
  const stat = await fs.stat(target);
  let directory = stat.isDirectory() ? target : path.dirname(target);
  const fallback = target;
  for (;;) {
    if (directory === retainedHost?.root) {
      // A retired workspace can leave only ignored modules behind. Other host
      // contents still belong to the host and must reach the inferred-root refusal.
      const entries = stat.isDirectory() ? await fs.readdir(target) : [];
      if (
        entries.length === 1 &&
        entries[0] === "node_modules" &&
        (await fs.lstat(path.join(target, "node_modules"))).isDirectory()
      ) {
        retainedHost.moduleOnlyRoots.add(target);
        return target;
      }
      return directory;
    }
    if (
      await fs.stat(path.join(directory, "package.json")).then(
        () => true,
        (error: unknown) => ignoreMissingUpdateCandidateFile(error) ?? false,
      )
    ) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return fallback;
    }
    directory = parent;
  }
}

export function assertUpdateCandidatePluginCopySource(source: string, privateRoot: string): void {
  if (isPathInside(source, privateRoot) || isPathInside(privateRoot, source)) {
    throw new Error("Plugin copy source overlaps update state");
  }
}

/** Measure the same dependency owners and private link graph that copying will materialize. */
export async function prepareUpdateCandidatePluginTrees(params: {
  roots: Map<string, string>;
  project: (source: string) => string;
  targetStateDir: string;
  candidateRoot: string;
  /** Retain selected host entries and the dependency owners reached from them. */
  retainedHostRoot?: string;
  /** Installed runtime lookups stop at the package manager's owning project. */
  retainedDependencyRoot?: string;
  onProgress?: () => void | Promise<void>;
}): Promise<UpdateCandidatePluginTreePlan> {
  return await withUpdateCandidatePluginFileHashing((hashFile) =>
    prepareUpdateCandidatePluginTreesWithHashing(params, hashFile),
  );
}

async function prepareUpdateCandidatePluginTreesWithHashing(
  params: Parameters<typeof prepareUpdateCandidatePluginTrees>[0],
  hashFile: UpdateCandidatePluginFileHasher,
): Promise<UpdateCandidatePluginTreePlan> {
  const roots = new Map(params.roots);
  const privateRoot = resolvePathViaExistingAncestorSync(path.resolve(params.targetStateDir));
  const candidateRoot = resolvePathViaExistingAncestorSync(path.resolve(params.candidateRoot));
  const scanned = new Set<string>();
  const staging = new Set<string>();
  const footprints = new Map<string, UpdateCandidatePluginEntry>();
  const edges = new Map<string, { target: string; real: string }>();
  const hosts = new Set<string>();
  const hostRoots = new Set<string>();
  const stores = new Set<string>();
  const moduleAliases = new Map<string, string>();
  const moduleOwners = new Set<string>();
  const isRecoveryArtifact = (file: string) => {
    for (let current = file; path.dirname(current) !== current; current = path.dirname(current)) {
      if (
        moduleOwners.has(path.dirname(current)) &&
        isPackageUpdateRecoveryArtifactName(path.basename(current))
      ) {
        return true;
      }
    }
    return false;
  };
  const retainedHostRoot = params.retainedHostRoot;
  const retainedHost = retainedHostRoot
    ? { root: retainedHostRoot, moduleOnlyRoots: new Set<string>() }
    : undefined;
  const isOwnedHostEdge = (file: string) =>
    path.basename(file) === "openclaw" && moduleOwners.has(path.dirname(file));
  const lookupRoots = (values: Iterable<string>) =>
    createRuntimePathLookup(Array.from(values, (root) => [root, root] as const));
  let rootLookup: ReturnType<typeof lookupRoots> | undefined;
  let retainedRootLookup: ReturnType<typeof lookupRoots> | undefined;
  let hostLookup = lookupRoots(hosts);
  let hostRootLookup = lookupRoots(hostRoots);
  const invalidateRoots = () => {
    rootLookup = undefined;
    retainedRootLookup = undefined;
  };
  const covered = (file: string) => (rootLookup ??= lookupRoots(roots.keys()))(file) !== undefined;
  const insideHost = (file: string) =>
    hostLookup(file) !== undefined &&
    !(
      retainedHostRoot &&
      isPathInside(retainedHostRoot, file) &&
      (retainedRootLookup ??= lookupRoots(
        [...roots.keys()].filter((root) => isPathInside(retainedHostRoot, root)),
      ))(file) !== undefined
    );
  const isRetainedDependency = (root: string) =>
    retainedHostRoot !== undefined &&
    root !== retainedHostRoot &&
    isPathInside(retainedHostRoot, root);
  const excludesInferredRoot = (root: string) =>
    !params.roots.has(root) &&
    ((insideHost(root) && !isRetainedDependency(root)) || hostRoots.has(root));
  function addRoot(source: string) {
    if (!roots.has(source)) {
      roots.set(source, params.project(source));
      invalidateRoots();
    }
  }
  async function readEntry(file: string): Promise<UpdateCandidatePluginEntry> {
    const stat = await fs.lstat(file, { bigint: true });
    const common = {
      path: file,
      size: Number(stat.size),
      mode: Number(stat.mode & 0o7777n),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
    };
    let entry: UpdateCandidatePluginEntry;
    if (stat.isDirectory()) {
      entry = { ...common, kind: "directory" };
    } else if (stat.isFile()) {
      entry = {
        ...common,
        kind: "file",
        birthtimeNs: stat.birthtimeNs.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
        uid: stat.uid.toString(),
        gid: stat.gid.toString(),
        sha256: await hashFile(file, stat),
      };
    } else if (stat.isSymbolicLink()) {
      const target =
        process.platform === "win32"
          ? await fs.stat(file).catch(ignoreUnresolvedPluginLink)
          : undefined;
      entry = {
        ...common,
        kind: "symlink",
        link: await fs.readlink(file),
        linkType: target?.isDirectory() ? "junction" : "file",
      };
    } else {
      throw new Error(`Unsupported plugin snapshot entry: ${file}`);
    }
    return entry;
  }
  async function recordEntry(entry: UpdateCandidatePluginEntry): Promise<void> {
    footprints.set(entry.path, entry);
    await params.onProgress?.();
  }
  async function measureEntry(file: string): Promise<UpdateCandidatePluginEntry> {
    const entry = await readEntry(file);
    await recordEntry(entry);
    return entry;
  }
  async function discoverHoistedDependencies(directory: string): Promise<void> {
    const manifest = await tryReadJson<unknown>(path.join(directory, "package.json"));
    if (!isRecord(manifest)) {
      return;
    }
    const boundary =
      params.retainedDependencyRoot && isPathInside(params.retainedDependencyRoot, directory)
        ? params.retainedDependencyRoot
        : undefined;
    const names = new Set<string>();
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const dependencies = manifest[field];
      if (isRecord(dependencies)) {
        for (const [name, spec] of Object.entries(dependencies)) {
          const parsed = parseRegistryNpmSpec(name);
          if (typeof spec === "string" && parsed?.name === name && parsed.selectorKind === "none") {
            names.add(name);
          }
        }
      }
    }
    for (const name of names) {
      for (let ancestor = directory; ; ancestor = path.dirname(ancestor)) {
        // Node skips a redundant node_modules/node_modules lookup.
        if (path.basename(ancestor) !== "node_modules") {
          const modulesDir = path.join(ancestor, "node_modules");
          if (boundary && !isPathInside(boundary, modulesDir)) {
            // Installed lookups stay inside the package manager's owning project.
            break;
          }
          const dependency = path.join(modulesDir, ...name.split("/"));
          const exists = await fs.stat(dependency).then(
            () => true,
            (error: unknown) => {
              if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ENOTDIR")) {
                return false;
              }
              throw error;
            },
          );
          if (exists) {
            const realModules = await fs.realpath(modulesDir);
            assertUpdateCandidatePluginCopySource(modulesDir, privateRoot);
            assertUpdateCandidatePluginCopySource(realModules, privateRoot);
            moduleOwners.add(realModules);
            if (realModules !== modulesDir) {
              moduleAliases.set(modulesDir, realModules);
            }
            if (boundary && isPathInside(modulesDir, boundary)) {
              // A global module directory is shared with unrelated packages.
              // Retain only the reached package; its manifest finds its own siblings.
              const realDependency = await fs.realpath(dependency);
              assertUpdateCandidatePluginCopySource(realDependency, privateRoot);
              addRoot(realDependency);
              if (realDependency !== dependency) {
                moduleAliases.set(dependency, realDependency);
              }
            } else {
              // Copy the reached module owner, not its repository. Its projected
              // ancestry preserves both nearest-package shadowing and sibling imports.
              addRoot(realModules);
            }
            break;
          }
        }
        if (path.dirname(ancestor) === ancestor) {
          // Missing optional dependencies remain absent; validation owns required ones.
          break;
        }
      }
    }
  }
  async function scan(directory: string): Promise<void> {
    assertUpdateCandidatePluginCopySource(directory, privateRoot);
    staging.delete(directory);
    if (scanned.has(directory)) {
      return;
    }
    scanned.add(directory);
    const rootEntry = await measureEntry(directory);
    if (rootEntry.kind === "symlink") {
      const target = path.resolve(path.dirname(directory), rootEntry.link);
      const real = await fs.realpath(directory);
      edges.set(directory, { target, real });
      if (path.basename(directory) === "node_modules") {
        moduleOwners.add(real);
        moduleAliases.set(directory, real);
      }
      return;
    }
    if (rootEntry.kind !== "directory") {
      return;
    }
    if (path.basename(directory) === "node_modules") {
      moduleOwners.add(directory);
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    // Listing names are only absence hints: retain canonical reads for filesystem aliases.
    const mayContain = (name: string) =>
      entries.some(
        (entry) => entry.name.toLowerCase() === name || /[^\x20-\x7e]|[. ]$/u.test(entry.name),
      );
    if (mayContain("package.json")) {
      await discoverHoistedDependencies(directory);
    }
    // Read before link discovery, so custom external stores retain their owner.
    const modules = mayContain(".modules.yaml")
      ? await readRuntimeModulesManifest(path.join(directory, ".modules.yaml"))
      : null;
    if (typeof modules?.manifest.virtualStoreDir === "string") {
      const store = await fs.realpath(path.resolve(directory, modules.manifest.virtualStoreDir));
      stores.add(store);
      addRoot(store);
    }
    // Register identities before visiting siblings: a physical module directory
    // may sort before the node_modules alias that establishes its ownership.
    for (const entry of entries) {
      if (entry.name === "node_modules" && (entry.isDirectory() || entry.isSymbolicLink())) {
        const owner = await fs
          .realpath(path.join(directory, entry.name))
          .catch(ignoreUnresolvedPluginLink);
        if (owner) {
          const source = path.join(directory, entry.name);
          assertUpdateCandidatePluginCopySource(owner, privateRoot);
          moduleOwners.add(owner);
          addRoot(owner);
          if (source !== owner) {
            moduleAliases.set(source, owner);
          }
        }
      }
    }
    const leaves = await runUpdateCandidatePluginTasks(
      entries
        .filter((entry) => {
          const file = path.join(directory, entry.name);
          return !entry.isDirectory() && !isRecoveryArtifact(file) && !isOwnedHostEdge(file);
        })
        .map((entry) => async () => {
          const file = path.join(directory, entry.name);
          const measured = await readEntry(file);
          if (measured.kind !== "symlink") {
            return { measured };
          }
          const target = path.resolve(directory, measured.link);
          const real = await fs
            .realpath(file)
            .catch((error: unknown) => ignoreUnresolvedPluginLink(error) ?? target);
          return { measured, edge: { target, real } };
        }),
    );
    const observations = new Map(leaves.map((leaf) => [leaf.measured.path, leaf]));
    // Reads can overlap; graph discovery and progress callbacks retain listing order.
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (isRecoveryArtifact(file)) {
        // Recovery controls and retained backups are not runtime dependencies.
        continue;
      } else if (isOwnedHostEdge(file)) {
        // The complete-wave owner pass records the authoritative host identity.
        continue;
      } else if (entry.isDirectory()) {
        if (isGitRuntimeStagingName(entry.name) && !roots.has(file)) {
          // Transaction links describe their final location. Incidental inventory
          // must not read candidate or rollback contents as live dependencies.
          staging.add(file);
        } else {
          await scan(file);
        }
      } else {
        const leaf = observations.get(file)!;
        await recordEntry(leaf.measured);
        if (leaf.edge) {
          edges.set(file, leaf.edge);
        }
      }
    }
  }
  async function refreshHostEdges(): Promise<void> {
    const discovered: Array<{ source: string; real?: string }> = [];
    for (const owner of moduleOwners) {
      const source = path.join(owner, "openclaw");
      const exists = await fs.lstat(source).then(
        () => true,
        (error: unknown) => {
          if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ENOTDIR")) {
            return false;
          }
          throw error;
        },
      );
      if (!exists) {
        continue;
      }
      const real = await fs.realpath(source).catch(ignoreMissingUpdateCandidateFile);
      discovered.push({ source, real });
    }
    hosts.clear();
    hostRoots.clear();
    for (const host of discovered) {
      if (
        discovered.some(
          (other) => other.source !== host.source && isPathInside(other.source, host.source),
        )
      ) {
        continue;
      }
      hosts.add(host.source);
      if (host.real) {
        hostRoots.add(host.real);
      }
    }
    hostLookup = lookupRoots(hosts);
    hostRootLookup = lookupRoots(hostRoots);
    // A later module alias can identify a host subtree that an earlier root
    // already scanned. Its discoveries must not become private dependency copies
    // or nested aliases beneath the immutable staged host edge.
    for (const root of roots.keys()) {
      if (excludesInferredRoot(root)) {
        roots.delete(root);
        invalidateRoots();
      }
    }
    for (const file of edges.keys()) {
      if (insideHost(file)) {
        edges.delete(file);
      }
    }
    for (const source of moduleAliases.keys()) {
      if (insideHost(source)) {
        moduleAliases.delete(source);
      }
    }
  }
  if (retainedHostRoot) {
    await discoverHoistedDependencies(retainedHostRoot);
  }
  // A locator can itself name a package inside a pnpm store or hoisted tree.
  // Within a known installation, selected host entries are not locators: their
  // owner is the host, whose manifest discovery above reaches the dependency
  // owners it actually uses instead of the whole shared module directory.
  const installationBoundsHost =
    retainedHostRoot !== undefined &&
    params.retainedDependencyRoot !== undefined &&
    isPathStrictlyInside(params.retainedDependencyRoot, retainedHostRoot);
  for (const source of params.roots.keys()) {
    if (
      source.split(path.sep).includes("node_modules") &&
      !(installationBoundsHost && isPathInside(retainedHostRoot, source))
    ) {
      addRoot(await dependencyOwner(source));
    }
  }
  for (;;) {
    for (const root of roots.keys()) {
      await scan(root);
    }
    // Module ownership is a complete-wave fact, independent of root order.
    await refreshHostEdges();
    const storeLookup = lookupRoots(stores);
    const stagingLookup = lookupRoots(staging);
    let added = false;
    for (const [file, { real, target }] of edges) {
      if (isRecoveryArtifact(file)) {
        edges.delete(file);
        continue;
      }
      if (isRecoveryArtifact(real) || isRecoveryArtifact(target)) {
        throw new Error("Package recovery state cannot be a runtime dependency.");
      }
      const directory = stagingLookup(real);
      if (directory && staging.delete(directory)) {
        // Explicit links still demand their source bytes and normal validation.
        await scan(directory);
        added = true;
      }
      if (
        (covered(real) && !(insideHost(real) && isRetainedDependency(real))) ||
        hostRoots.has(real) ||
        (isUpdateCandidateHostLauncher(file) && hostRootLookup(real) !== undefined)
      ) {
        continue;
      }
      // Internal dangling links remain dangling. External missing targets cannot
      // be materialized without leaving an escape into the serving filesystem.
      const store = storeLookup(real);
      // The enclosing store excludes host contents; select the reached host package,
      // or another discovery wave would keep selecting that same incomplete store.
      const retainedDependency = insideHost(real) && isRetainedDependency(real);
      const owner =
        (!retainedDependency ? store : undefined) ??
        (await dependencyOwner(
          real,
          retainedDependency,
          isRetainedDependency(real) ? retainedHost : undefined,
        ).catch((cause: unknown) => {
          throw new Error(`Cannot privately copy plugin dependency ${file} -> ${real}`, { cause });
        }));
      if (excludesInferredRoot(owner)) {
        throw new Error(
          `Cannot privately copy host-owned plugin link ${file} -> ${real}; use the openclaw package/SDK import or a separately owned plugin dependency.`,
        );
      }
      assertUpdateCandidatePluginCopySource(owner, privateRoot);
      addRoot(owner);
      added = true;
    }
    if (!added) {
      break;
    }
  }
  const copies = [...roots].filter(
    ([source]) =>
      ![...roots.keys()].some((other) => other !== source && isPathInside(other, source)),
  );
  const copyOwner = createRuntimePathLookup(copies.map((copy) => [copy[0], copy] as const));
  function projected(file: string): string {
    const copy = copyOwner(file);
    if (!copy) {
      throw new Error("Plugin dependency has no private copy owner");
    }
    return path.join(copy[1], path.relative(copy[0], file));
  }
  const relocations: RuntimeRelocation[] = copies.map(([sourceRoot, destinationRoot]) => ({
    sourceRoot,
    destinationRoot,
  }));
  for (const [sourceRoot, real] of moduleAliases) {
    relocations.push({ sourceRoot, destinationRoot: projected(real) });
  }
  for (const root of [...hostRoots, ...hosts]) {
    relocations.push({ sourceRoot: root, destinationRoot: candidateRoot });
  }
  for (const [file, { target, real }] of edges) {
    const host = isUpdateCandidateHostLauncher(file)
      ? hostRootLookup(real)
      : hostRoots.has(real)
        ? real
        : undefined;
    relocations.push({
      sourceRoot: target,
      destinationRoot: host ? path.join(candidateRoot, path.relative(host, real)) : projected(real),
    });
  }
  relocations.sort((a, b) => b.sourceRoot.length - a.sourceRoot.length);
  const hostLinks = new Set(
    [...hosts].filter((root) => root !== params.retainedHostRoot).map(projected),
  );
  const entries = [...footprints.values()].filter((entry) => {
    if (
      isRecoveryArtifact(entry.path) ||
      insideHost(entry.path) ||
      copyOwner(entry.path) === undefined
    ) {
      return false;
    }
    // Owner selection precedes scanning; bind its exception to the actual inventory.
    const moduleOnlyRoots = retainedHost?.moduleOnlyRoots;
    if (
      (moduleOnlyRoots?.has(entry.path) &&
        (entry.kind !== "directory" ||
          footprints.get(path.join(entry.path, "node_modules"))?.kind !== "directory")) ||
      (moduleOnlyRoots?.has(path.dirname(entry.path)) &&
        (path.basename(entry.path) !== "node_modules" || entry.kind !== "directory"))
    ) {
      throw new Error(`Retired workspace changed during runtime retention: ${entry.path}`);
    }
    return true;
  });
  // Full lengths and entry metadata bound copies even when sources have sparse extents.
  const bytes = entries.reduce(
    (total, entry) => total + Math.max(4096, Math.ceil(entry.size / 4096) * 4096),
    (hostLinks.size + moduleAliases.size) * 4096,
  );
  const aliases = [...moduleAliases].map<[string, string]>(([source, real]) => {
    const owner = copyOwner(source);
    const alias = owner
      ? path.join(owner[1], path.relative(owner[0], source))
      : params.project(source);
    return [alias, projected(real)];
  });
  return {
    bytes,
    privateRoot,
    candidateRoot,
    copies,
    entries,
    hostLinks: [...hostLinks],
    relocations,
    aliases,
    moduleBindings: [...moduleAliases],
    edges: [...edges].map(([source, edge]) => ({ source, target: edge.target, real: edge.real })),
  };
}

/** Execute the admitted graph without rediscovering owners from newer source state. */
export async function copyUpdateCandidatePluginTrees(
  plan: UpdateCandidatePluginTreePlan,
  params: {
    targetStateDir: string;
    candidateRoot: string;
    onCodeLink?: (fact: UpdateCandidatePluginCodeLink) => void;
    onProgress?: () => void;
  },
): Promise<void> {
  const targets = resolveUpdateCandidatePluginTreeTargets(plan, params, params.onProgress);
  const { privateRoot, candidateRoot, copies, hostLinks, relocations, destinationFor } = targets;
  const assertEntry = async (entry: UpdateCandidatePluginEntry) => {
    assertUpdateCandidatePluginEntryStat(entry, await fs.lstat(entry.path, { bigint: true }));
    if (entry.kind === "symlink" && (await fs.readlink(entry.path)) !== entry.link) {
      throw new Error(`Plugin entry changed after snapshot inventory: ${entry.path}`);
    }
    params.onProgress?.();
  };
  const assertEntries = async () => {
    await runUpdateCandidatePluginTasks(plan.entries.map((entry) => () => assertEntry(entry)));
  };
  await targets.assertBindings();
  await assertEntries();
  await fs.mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const rootIdentity = await readDirectoryIdentity(privateRoot);
  const destinationRoot = await openRoot(privateRoot);
  assertDirectoryIdentitySync(privateRoot, rootIdentity);
  const preparedDirectories = new Set([privateRoot]);
  for (const entry of plan.entries) {
    if (entry.kind === "directory") {
      const destination = destinationFor(entry.path);
      await fs.mkdir(destination, { recursive: true, mode: entry.mode | 0o700 });
      params.onProgress?.();
      preparedDirectories.add(destination);
    }
  }
  // File roots and missing-entry repairs can omit their parent directory entries.
  // Prepare each parent once before admitting concurrent copies.
  for (const entry of plan.entries) {
    if (entry.kind !== "directory") {
      const parent = path.dirname(destinationFor(entry.path));
      if (!preparedDirectories.has(parent)) {
        await fs.mkdir(parent, { recursive: true, mode: 0o700 });
        params.onProgress?.();
        preparedDirectories.add(parent);
      }
    }
  }
  const files = plan.entries.filter((entry) => entry.kind === "file");
  await copyUpdateCandidatePluginFiles(files, {
    privateRoot,
    rootIdentity,
    destinationRoot,
    destinationFor,
    onProgress: params.onProgress,
  });
  for (const entry of plan.entries) {
    if (entry.kind === "symlink") {
      await assertEntry(entry);
      const destination = destinationFor(entry.path);
      await fs.symlink(entry.link, destination, entry.linkType);
      params.onProgress?.();
    }
  }
  await targets.assertBindings();
  await assertEntries();
  for (const entry of plan.entries) {
    if (entry.kind !== "directory") {
      const target = destinationFor(entry.path);
      const relocate =
        entry.kind === "symlink" ? relocateRuntimeSymlink : resolveRuntimeFileRelocator(target);
      if (relocate) {
        await relocate(target, entry.path, target, relocations);
        params.onProgress?.();
      }
    }
  }
  const privateAliases = await publishUpdateCandidatePluginTreeLinks({
    privateRoot,
    candidateRoot,
    hostLinks,
    aliases: targets.aliases,
  });
  const verification = {
    privateRoot,
    candidateRoot,
    hostLinks,
    onCodeLink: params.onCodeLink,
    onProgress: params.onProgress,
  };
  for (const treeRoot of [...privateAliases, ...copies.map(([, target]) => target)]) {
    await verifyUpdateCandidatePluginTree(treeRoot, verification);
  }
  for (const entry of plan.entries) {
    if (entry.kind === "file" && (entry.mode & 0o600) !== 0o600) {
      await fs.chmod(destinationFor(entry.path), entry.mode);
      params.onProgress?.();
    }
  }
  for (const entry of plan.entries
    .filter((candidate) => candidate.kind === "directory")
    .toSorted((left, right) => right.path.length - left.path.length)) {
    await fs.chmod(destinationFor(entry.path), entry.mode);
    params.onProgress?.();
  }
}
