import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { root as openRoot } from "./fs-safe.js";
import { tryReadJson } from "./json-files.js";
import { parseRegistryNpmSpec } from "./npm-registry-spec.js";
import { hasNodeErrorCode, isPathInside } from "./path-guards.js";
import type { UpdateCandidatePluginCodeLink } from "./update-candidate-plugin-code-links.js";
import {
  assertUpdateCandidatePluginEntryStat,
  isUpdateCandidateHostLauncher,
  publishUpdateCandidatePluginTreeLinks,
  resolveUpdateCandidatePluginTreeTargets,
  verifyUpdateCandidatePluginTree,
} from "./update-candidate-plugin-tree-links.js";
import { createRuntimePathLookup } from "./update-runtime-path-index.js";
import {
  readRuntimeModulesManifest,
  relocateRuntimeEntry,
  type RuntimeRelocation,
} from "./update-runtime-relocation.js";
import { isGitRuntimeStagingName } from "./update-runtime-staging.js";

const entryFields = {
  path: z.string(),
  size: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative(),
  dev: z.string(),
  ino: z.string(),
};
const UpdateCandidatePluginEntrySchema = z.discriminatedUnion("kind", [
  z.object({ ...entryFields, kind: z.literal("directory") }),
  z.object({
    ...entryFields,
    kind: z.literal("file"),
    birthtimeNs: z.string(),
    mtimeNs: z.string(),
    ctimeNs: z.string(),
  }),
  z.object({
    ...entryFields,
    kind: z.literal("symlink"),
    link: z.string(),
    linkType: z.enum(["file", "junction"]),
  }),
]);
type UpdateCandidatePluginEntry = z.infer<typeof UpdateCandidatePluginEntrySchema>;

export const UpdateCandidatePluginTreePlanSchema = z.object({
  bytes: z.number().int().nonnegative(),
  privateRoot: z.string(),
  candidateRoot: z.string(),
  copies: z.array(z.tuple([z.string(), z.string()])),
  entries: z.array(UpdateCandidatePluginEntrySchema),
  hostLinks: z.array(z.string()),
  relocations: z.array(z.object({ sourceRoot: z.string(), destinationRoot: z.string() })),
  aliases: z.array(z.tuple([z.string(), z.string()])),
  moduleBindings: z.array(z.tuple([z.string(), z.string()])),
  edges: z.array(z.object({ source: z.string(), target: z.string(), real: z.string() })),
});
export type UpdateCandidatePluginTreePlan = z.infer<typeof UpdateCandidatePluginTreePlanSchema>;

async function dependencyOwner(target: string, retainedHostRoot?: string): Promise<string> {
  // A pnpm package resolves dependencies beside its package directory. Preserve
  // that Node lookup ancestry, including scoped packages and nested installs.
  const parts = target.split(path.sep);
  const store = parts.indexOf(".pnpm");
  if (store >= 0 && !retainedHostRoot) {
    return parts.slice(0, store + 1).join(path.sep);
  }
  const modules = parts.indexOf("node_modules");
  if (modules >= 0 && !retainedHostRoot) {
    return parts.slice(0, modules + 1).join(path.sep);
  }
  let directory = (await fs.stat(target)).isDirectory() ? target : path.dirname(target);
  const fallback = target;
  for (;;) {
    // Retired workspaces can retain ignored modules after their manifest disappears.
    // Keep the reached subtree without promoting it to the complete retained host.
    if (directory === retainedHostRoot) {
      return fallback;
    }
    if (
      await fs.stat(path.join(directory, "package.json")).then(
        () => true,
        (error: unknown) => {
          if (hasNodeErrorCode(error, "ENOENT")) {
            return false;
          }
          throw error;
        },
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
  onProgress?: () => void | Promise<void>;
}): Promise<UpdateCandidatePluginTreePlan> {
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
  const retainedHostRoot = params.retainedHostRoot;
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
  async function measureEntry(file: string): Promise<UpdateCandidatePluginEntry> {
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
      };
    } else if (stat.isSymbolicLink()) {
      const target =
        process.platform === "win32"
          ? await fs.stat(file).catch((error: unknown) => {
              if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ELOOP")) {
                return undefined;
              }
              throw error;
            })
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
    footprints.set(file, entry);
    await params.onProgress?.();
    return entry;
  }
  async function discoverHoistedDependencies(directory: string): Promise<void> {
    const manifest = await tryReadJson<unknown>(path.join(directory, "package.json"));
    if (!isRecord(manifest)) {
      return;
    }
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
            // Copy the reached module owner, not its repository. Its projected
            // ancestry preserves both nearest-package shadowing and sibling imports.
            const realModules = await fs.realpath(modulesDir);
            assertUpdateCandidatePluginCopySource(modulesDir, privateRoot);
            assertUpdateCandidatePluginCopySource(realModules, privateRoot);
            moduleOwners.add(realModules);
            addRoot(realModules);
            if (realModules !== modulesDir) {
              moduleAliases.set(modulesDir, realModules);
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
          .catch((error: unknown) => {
            if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ELOOP")) {
              return undefined;
            }
            throw error;
          });
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
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (isOwnedHostEdge(file)) {
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
        const measured = await measureEntry(file);
        if (measured.kind !== "symlink") {
          continue;
        }
        const target = path.resolve(directory, measured.link);
        const real = await fs.realpath(file).catch((error: unknown) => {
          if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ELOOP")) {
            return target;
          }
          throw error;
        });
        edges.set(file, { target, real });
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
      const real = await fs.realpath(source).catch((error: unknown) => {
        if (hasNodeErrorCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
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
  for (const source of params.roots.keys()) {
    if (source.split(path.sep).includes("node_modules")) {
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
    for (const [file, { real }] of edges) {
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
          isRetainedDependency(real) ? retainedHostRoot : undefined,
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
  for (const root of hostRoots) {
    relocations.push({ sourceRoot: root, destinationRoot: candidateRoot });
  }
  for (const host of hosts) {
    relocations.push({ sourceRoot: host, destinationRoot: candidateRoot });
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
  const entries = [...footprints.values()].filter(
    (entry) => !insideHost(entry.path) && copyOwner(entry.path) !== undefined,
  );
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
  },
): Promise<void> {
  const targets = resolveUpdateCandidatePluginTreeTargets(plan, params);
  const { privateRoot, candidateRoot, copies, hostLinks, relocations, destinationFor } = targets;
  const assertEntry = async (entry: UpdateCandidatePluginEntry) => {
    assertUpdateCandidatePluginEntryStat(entry, await fs.lstat(entry.path, { bigint: true }));
    if (entry.kind === "symlink" && (await fs.readlink(entry.path)) !== entry.link) {
      throw new Error(`Plugin entry changed after snapshot inventory: ${entry.path}`);
    }
  };
  await targets.assertBindings();
  for (const entry of plan.entries) {
    await assertEntry(entry);
  }
  await fs.mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const destinationRoot = await openRoot(privateRoot);
  const preparedDirectories = new Set([privateRoot]);
  for (const entry of plan.entries) {
    if (entry.kind === "directory") {
      const destination = destinationFor(entry.path);
      await fs.mkdir(destination, { recursive: true, mode: entry.mode | 0o700 });
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
        preparedDirectories.add(parent);
      }
    }
  }
  const copied = await runTasksWithConcurrency({
    limit: 4,
    errorMode: "stop",
    tasks: plan.entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => async () => {
        await assertEntry(entry);
        const destination = destinationFor(entry.path);
        // copyIn owns portable create-only publication; no-replace move needs a
        // native binding. Recheck the inventory before its private stage is published.
        await destinationRoot.copyIn(path.relative(privateRoot, destination), entry.path, {
          overwrite: false,
          // Rehearsal payloads are disposable and never serve as recovery backups.
          durable: false,
          maxBytes: entry.size,
          mode: entry.mode | 0o600,
          sourceHardlinks: "allow",
          assertBeforeMutation: () =>
            assertUpdateCandidatePluginEntryStat(
              entry,
              fsSync.lstatSync(entry.path, { bigint: true }),
            ),
        });
        await assertEntry(entry);
      }),
  });
  // A failed copy can already have published bytes. Drain every admitted copy
  // before the caller can clean up, or before any link publication begins.
  if (copied.hasError) {
    throw copied.firstError;
  }
  for (const entry of plan.entries) {
    if (entry.kind === "symlink") {
      await assertEntry(entry);
      const destination = destinationFor(entry.path);
      await fs.symlink(entry.link, destination, entry.linkType);
    }
  }
  await targets.assertBindings();
  for (const entry of plan.entries) {
    await assertEntry(entry);
  }
  for (const entry of plan.entries) {
    if (entry.kind !== "directory") {
      const target = destinationFor(entry.path);
      await relocateRuntimeEntry(target, entry.path, target, entry.kind, relocations);
    }
  }
  const privateAliases = await publishUpdateCandidatePluginTreeLinks({
    privateRoot,
    candidateRoot,
    hostLinks,
    aliases: targets.aliases,
  });
  const verification = { privateRoot, candidateRoot, hostLinks, onCodeLink: params.onCodeLink };
  for (const alias of privateAliases) {
    await verifyUpdateCandidatePluginTree(alias, verification);
  }
  for (const [, target] of copies) {
    await verifyUpdateCandidatePluginTree(target, verification);
  }
  for (const entry of plan.entries) {
    if (entry.kind === "file" && (entry.mode & 0o600) !== 0o600) {
      await fs.chmod(destinationFor(entry.path), entry.mode);
    }
  }
  for (const entry of plan.entries
    .filter((candidate) => candidate.kind === "directory")
    .toSorted((left, right) => right.path.length - left.path.length)) {
    await fs.chmod(destinationFor(entry.path), entry.mode);
  }
}
