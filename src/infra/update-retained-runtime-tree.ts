import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { collectBundledPluginPublicSurfaceArtifacts } from "../plugins/bundled-plugin-scan.js";
import { isPluginControlUiAssetPath } from "../plugins/control-ui-assets.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { listBuiltRuntimeEntryCandidates } from "../plugins/package-entrypoints.js";
import { DEFAULT_PLUGIN_ENTRY_CANDIDATES } from "../plugins/package-manifest.js";
import {
  parsePluginCacheJson,
  pluginCacheRealpathSync,
  readPluginCacheFile,
} from "../plugins/plugin-cache-files.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import {
  isPluginActivityToolName,
  PLUGIN_ACTIVITY_ICON_PATH,
  PLUGIN_TOOL_ACTIVITY_ICON_DIR,
  PORTABLE_PLUGIN_ICON_PATH,
} from "../plugins/portable-icon-paths.js";
import { PUBLIC_SURFACE_SOURCE_EXTENSIONS } from "../plugins/public-surface-runtime.js";
import { root as openRoot } from "./fs-safe.js";
import { hasNodeErrorCode, isPathInside } from "./path-guards.js";
import {
  assertUpdateCandidatePluginEntryStat,
  assertUpdateCandidatePluginLinkTarget,
  publishUpdateCandidatePluginTreeLinks,
  resolveUpdateCandidatePluginTreeTargets,
  type UpdateCandidatePluginTreeEntry,
  verifyUpdateCandidatePluginTree,
} from "./update-candidate-plugin-tree-links.js";
import type { UpdateCandidatePluginTreePlan } from "./update-candidate-plugin-tree.js";
import { createRuntimePathLookup } from "./update-runtime-path-index.js";
import { relocateRuntimeEntry } from "./update-runtime-relocation.js";

// Relocation rewrites these members in place; a hard link would edit the live package.
const isRelocatedFile = (file: string) =>
  path.basename(file) === ".modules.yaml" ||
  (path.basename(path.dirname(file)) === ".bin" && !file.endsWith(".exe"));

const isLinkUnsupported = (error: unknown) =>
  ["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS"].some((code) =>
    hasNodeErrorCode(error, code),
  );

/**
 * Retain the admitted tree by hard-linking its files into the private directory.
 *
 * Retention only needs the inventoried inodes to outlive the installer's rename or
 * unlink, so files share their inode with the source and bytes are copied only when
 * the filesystem cannot preserve identity, a plugin boundary checks it, or relocation rewrites it.
 * One walk performs the inventory check, publication, relocation, and escape check
 * for every entry.
 */
export async function linkUpdateCandidatePluginTrees(
  plan: UpdateCandidatePluginTreePlan,
  params: {
    targetStateDir: string;
    candidateRoot: string;
    onProgress?: () => void | Promise<void>;
  },
): Promise<{ linked: number; copied: number }> {
  const targets = resolveUpdateCandidatePluginTreeTargets(plan, params);
  const { privateRoot, candidateRoot, hostLinks, relocations, destinationFor } = targets;
  // Linking bumps the source inode's change time. Later entries that share that
  // inode (pnpm store hard links) must match the recorded post-link fingerprint.
  const linkedInodes = new Map<string, string>();
  const assertEntryStat = (entry: UpdateCandidatePluginTreeEntry, current: BigIntStats) => {
    const expected =
      entry.kind === "file" && linkedInodes.has(`${entry.dev}:${entry.ino}`)
        ? { ...entry, ctimeNs: linkedInodes.get(`${entry.dev}:${entry.ino}`)! }
        : entry;
    assertUpdateCandidatePluginEntryStat(expected, current);
  };
  const assertEntry = async (entry: UpdateCandidatePluginTreeEntry) => {
    await params.onProgress?.();
    assertEntryStat(entry, await fs.lstat(entry.path, { bigint: true }));
    if (entry.kind === "symlink" && (await fs.readlink(entry.path)) !== entry.link) {
      throw new Error(`Plugin entry changed after snapshot inventory: ${entry.path}`);
    }
  };
  const pluginFiles = new Set<string>();
  const entryKinds = new Map(plan.entries.map((entry) => [entry.path, entry.kind]));
  const activityScopes: Array<readonly [string, string]> = [];
  const browserScopes: Array<readonly [string, string]> = [];
  await withPluginCache(createPluginCache({ kind: "operation" }), async () => {
    for (const entry of plan.entries) {
      if (path.basename(entry.path) !== "openclaw.plugin.json") {
        continue;
      }
      await assertEntry(entry);
      const rootDir = path.dirname(entry.path);
      const add = (relative: string) => {
        const file = path.resolve(rootDir, relative);
        const real = isPathInside(rootDir, file) ? pluginCacheRealpathSync(file) : null;
        if (real && isPathInside(rootDir, real) && entryKinds.get(real) === "file") {
          pluginFiles.add(real);
        }
      };
      // Older projections may already have linked these admitted metadata files.
      // Reading their paths is not plugin admission; loading keeps its strict guard.
      const loaded = loadPluginManifest(rootDir, false);
      const manifest = loaded.ok ? loaded.manifest : undefined;
      const packageFile = readPluginCacheFile({
        rootDir,
        relativePath: "package.json",
        rejectHardlinks: false,
        maxBytes: 256 * 1024,
      });
      const parsed = packageFile.ok ? parsePluginCacheJson(packageFile) : undefined;
      const metadata =
        parsed?.ok && isRecord(parsed.value) && isRecord(parsed.value.openclaw)
          ? parsed.value.openclaw
          : {};
      const sources = normalizeTrimmedStringList([
        ...(Array.isArray(metadata.extensions)
          ? metadata.extensions
          : DEFAULT_PLUGIN_ENTRY_CANDIDATES),
        ...(Array.isArray(metadata.runtimeExtensions) ? metadata.runtimeExtensions : []),
        metadata.setupEntry,
        metadata.runtimeSetupEntry,
        manifest?.providerCatalogEntry,
        manifest?.capabilityCatalogEntry,
      ]);
      for (const directory of new Set([
        rootDir,
        path.join(rootDir, "dist"),
        ...sources.map((source) => path.dirname(path.resolve(rootDir, source))),
      ])) {
        if (isPathInside(rootDir, directory) && entryKinds.get(directory) === "directory") {
          for (const artifact of collectBundledPluginPublicSurfaceArtifacts({
            pluginDir: directory,
            sourceEntry: "",
          }) ?? []) {
            sources.push(
              ...PUBLIC_SURFACE_SOURCE_EXTENSIONS.map((extension) =>
                path.relative(rootDir, path.join(directory, artifact.replace(/\.js$/u, extension))),
              ),
            );
          }
        }
      }
      [
        "openclaw.plugin.json",
        "package.json",
        PORTABLE_PLUGIN_ICON_PATH,
        PLUGIN_ACTIVITY_ICON_PATH,
      ].forEach(add);
      for (const source of sources) {
        add(source);
        listBuiltRuntimeEntryCandidates(source).forEach(add);
      }
      for (const theme of manifest?.themes ?? []) {
        [
          theme.source,
          ...Object.values(theme.hats ?? {}),
          ...Object.values(theme.critters ?? {}).map((critter) => critter.source),
        ].forEach(add);
      }
      const activity = path.join(rootDir, PLUGIN_TOOL_ACTIVITY_ICON_DIR);
      const browser =
        manifest?.controlUi && path.resolve(rootDir, path.dirname(manifest.controlUi.entry));
      activityScopes.push([activity, activity]);
      if (browser && isPathInside(rootDir, browser)) {
        browserScopes.push([browser, browser]);
      }
    }
  });
  // Nested contracts validate paths relative to their own root, not an ancestor.
  const deepestFirst = ([left]: readonly [string, string], [right]: readonly [string, string]) =>
    right.length - left.length;
  const activityScope = createRuntimePathLookup(activityScopes.toSorted(deepestFirst));
  const browserScope = createRuntimePathLookup(browserScopes.toSorted(deepestFirst));
  for (const entry of plan.entries) {
    if (entry.kind !== "file") {
      continue;
    }
    const activity = activityScope(entry.path);
    const browser = browserScope(entry.path);
    if (
      (activity &&
        path.dirname(entry.path) === activity &&
        entry.path.endsWith(".svg") &&
        isPluginActivityToolName(path.basename(entry.path, ".svg"))) ||
      (browser &&
        isPluginControlUiAssetPath(path.relative(browser, entry.path).split(path.sep).join("/")))
    ) {
      pluginFiles.add(entry.path);
    }
  }
  await targets.assertBindings();
  await fs.mkdir(privateRoot, { recursive: true, mode: 0o700 });
  let destinationRoot: Awaited<ReturnType<typeof openRoot>> | undefined;
  const copyEntry = async (
    entry: Extract<UpdateCandidatePluginTreeEntry, { kind: "file" }>,
    destination: string,
  ) => {
    destinationRoot ??= await openRoot(privateRoot);
    // copyIn owns portable create-only publication; recheck the inventory before
    // its private stage is published.
    await destinationRoot.copyIn(path.relative(privateRoot, destination), entry.path, {
      overwrite: false,
      // The entry loop already prepares each destination parent.
      mkdir: false,
      maxBytes: entry.size,
      mode: entry.mode | 0o600,
      sourceHardlinks: "allow",
      assertBeforeMutation: () =>
        assertEntryStat(entry, fsSync.lstatSync(entry.path, { bigint: true })),
    });
    await assertEntry(entry);
    await relocateRuntimeEntry(destination, entry.path, destination, "file", relocations);
    if ((entry.mode & 0o600) !== 0o600) {
      await fs.chmod(destination, entry.mode);
    }
  };
  // OverlayFS hard links can copy lower-layer files up, changing birthtime (or
  // inode identity). Copy instead of relaxing the admitted file fingerprint.
  const copyDevices = new Map<string, boolean>();
  const requiresCopy = async (entry: UpdateCandidatePluginTreeEntry) => {
    if (process.platform !== "linux") {
      return false;
    }
    let copy = copyDevices.get(entry.dev);
    if (copy === undefined) {
      copy = (await fs.statfs(entry.path)).type === 0x794c7630;
      copyDevices.set(entry.dev, copy);
    }
    return copy;
  };
  const counts = { linked: 0, copied: 0 };
  const directories: Array<Extract<UpdateCandidatePluginTreeEntry, { kind: "directory" }>> = [];
  for (const entry of plan.entries) {
    await assertEntry(entry);
    const destination = destinationFor(entry.path);
    if (entry.kind === "directory") {
      await fs.mkdir(destination, { recursive: true, mode: entry.mode | 0o700 });
      directories.push(entry);
      continue;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (entry.kind === "symlink") {
      await fs.symlink(entry.link, destination, entry.linkType);
      await relocateRuntimeEntry(destination, entry.path, destination, "symlink", relocations);
      assertUpdateCandidatePluginLinkTarget(
        destination,
        path.resolve(path.dirname(destination), await fs.readlink(destination)),
        { privateRoot, candidateRoot },
      );
      continue;
    }
    if (
      pluginFiles.has(entry.path) ||
      isRelocatedFile(destination) ||
      (await requiresCopy(entry))
    ) {
      await copyEntry(entry, destination);
      counts.copied += 1;
      continue;
    }
    try {
      await fs.link(entry.path, destination);
    } catch (error) {
      if (!isLinkUnsupported(error)) {
        throw error;
      }
      await copyEntry(entry, destination);
      counts.copied += 1;
      continue;
    }
    // The private name must reference the inventoried inode, never a newer file.
    const linked = await fs.lstat(destination, { bigint: true });
    if (
      !linked.isFile() ||
      linked.dev.toString() !== entry.dev ||
      linked.ino.toString() !== entry.ino
    ) {
      throw new Error(
        `Retained runtime entry does not reference its inventoried file: ${entry.path}`,
      );
    }
    assertUpdateCandidatePluginEntryStat({ ...entry, ctimeNs: linked.ctimeNs.toString() }, linked);
    linkedInodes.set(`${entry.dev}:${entry.ino}`, linked.ctimeNs.toString());
    counts.linked += 1;
  }
  await targets.assertBindings();
  const privateAliases = await publishUpdateCandidatePluginTreeLinks({
    privateRoot,
    candidateRoot,
    hostLinks,
    aliases: targets.aliases,
  });
  for (const alias of privateAliases) {
    await verifyUpdateCandidatePluginTree(alias, { privateRoot, candidateRoot, hostLinks });
  }
  for (const entry of directories.toSorted((left, right) => right.path.length - left.path.length)) {
    await fs.chmod(destinationFor(entry.path), entry.mode);
  }
  return counts;
}
