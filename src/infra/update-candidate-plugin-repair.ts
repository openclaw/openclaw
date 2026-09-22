import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { isPluginInPackageBundledRoots } from "../plugins/bundled-dir.js";
import { discoverConfiguredPluginLoadPaths } from "../plugins/discovery.js";
import { inspectPluginSourceDependencies } from "../plugins/plugin-generation-source-inspection.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { resolveOpenClawPackageRootSync } from "./openclaw-root.js";
import { hasNodeErrorCode, isPathInside } from "./path-guards.js";
import {
  resolveUpdateCandidatePluginPath,
  resolveUpdateCandidatePluginSourcePath,
} from "./update-candidate-paths.js";
import { resolveUpdateCandidatePluginSourceEntries } from "./update-candidate-plugin-sources.js";
import {
  copyUpdateCandidatePluginTrees,
  prepareUpdateCandidatePluginTrees,
} from "./update-candidate-plugin-tree.js";
import { resolveUpdateRehearsalRoot } from "./update-rehearsal-paths.js";

async function readOptionalFile(file: string): Promise<Buffer | undefined> {
  return fs.readFile(file).catch((error: unknown) => {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
}

/** Complete a published driver's private snapshot before candidate Doctor loads plugins. */
export async function completeUpdateCandidatePluginRehearsal(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  candidateRoot?: string;
  installRecords?: Record<string, PluginInstallRecord>;
}): Promise<{ copiedFiles: number; warnings: string[] }> {
  const rehearsalRoot = resolveUpdateRehearsalRoot(params.env);
  const warnings: string[] = [];
  if (!rehearsalRoot || params.env.OPENCLAW_UPDATE_IN_PROGRESS !== "1") {
    return { copiedFiles: 0, warnings };
  }
  const privateRoot = await fs.realpath(rehearsalRoot);
  const assertPrivate = (file: string) => {
    if (
      !isPathInside(privateRoot, path.resolve(file)) ||
      !isPathInside(privateRoot, resolvePathViaExistingAncestorSync(file))
    ) {
      throw new Error(`Plugin dependency is outside the temporary update copy: ${file}`);
    }
  };
  const isPrivateLookup = (specifier: string) => {
    const absolute = specifier.startsWith("file:")
      ? fileURLToPath(specifier)
      : path.isAbsolute(specifier)
        ? specifier
        : undefined;
    return !absolute || isPathInside(privateRoot, absolute);
  };
  const sources = new Set(params.config.plugins?.load?.paths ?? []);
  for (const record of [
    ...Object.values(params.installRecords ?? {}),
    ...Object.values(params.config.plugins?.installs ?? {}),
  ]) {
    if (record.installPath) {
      sources.add(record.installPath);
    }
    if (record.source === "path" && record.sourcePath) {
      sources.add(record.sourcePath);
    }
  }
  if (sources.size === 0) {
    return { copiedFiles: 0, warnings };
  }
  const candidateRoot =
    params.candidateRoot ?? resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  if (!candidateRoot) {
    throw new Error("Cannot locate the staged OpenClaw installation for plugin setup");
  }
  const discovery = discoverConfiguredPluginLoadPaths({
    loadPaths: [...sources],
    deduplicate: true,
    env: params.env,
  });
  const entries = resolveUpdateCandidatePluginSourceEntries(
    discovery.candidates.filter(
      (candidate) =>
        isPathInside(privateRoot, candidate.rootDir) ||
        !isPluginInPackageBundledRoots({ rootDir: candidate.rootDir, packageRoot: candidateRoot }),
    ),
    params.config,
  );
  const originals: Array<{ rootDir: string; entryFile: string }> = [];
  const comparedFiles = new Map<string, string>();
  const project = (source: string) =>
    resolveUpdateCandidatePluginPath(privateRoot, privateRoot, source);
  const assertMatchingFile = async (source: string, copied: string) => {
    assertPrivate(copied);
    const [original, existing] = await Promise.all([
      readOptionalFile(source),
      readOptionalFile(copied),
    ]);
    if (
      (original === undefined) !== (existing === undefined) ||
      (original && existing && !original.equals(existing))
    ) {
      throw new Error(
        `Plugin source changed since the update snapshot: ${source}. Retry the update after plugin edits finish.`,
      );
    }
  };
  for (const entry of entries) {
    assertPrivate(entry.rootDir);
    assertPrivate(entry.entryFile);
    const copiedGraph = inspectPluginSourceDependencies([entry]);
    for (const reference of copiedGraph.references) {
      // Explicit external imports retain their source semantics. Lookups naming
      // private paths must not escape through a symlink, including absolute paths.
      if (isPathInside(privateRoot, reference.source) && isPrivateLookup(reference.specifier)) {
        assertPrivate(reference.target);
      }
    }
    copiedGraph.assertSourceCurrent();
    const unresolvedPrivate = copiedGraph.unresolved.filter(
      ({ source, specifier }) => isPathInside(privateRoot, source) && isPrivateLookup(specifier),
    );
    if (unresolvedPrivate.length === 0) {
      continue;
    }
    const [copiedRoot, copiedEntry] = await Promise.all([
      fs.realpath(entry.rootDir),
      fs.realpath(entry.entryFile),
    ]);
    const rootDir = resolveUpdateCandidatePluginSourcePath(privateRoot, copiedRoot);
    const entryFile = resolveUpdateCandidatePluginSourcePath(privateRoot, copiedEntry);
    if (!rootDir || !entryFile || !isPathInside(rootDir, entryFile)) {
      warnings.push(
        `Update checks could not recover the original plugin path for ${entry.entryFile}.`,
      );
      continue;
    }
    const missingReferences = new Set(
      unresolvedPrivate.flatMap(({ source, specifier }) => {
        const original = resolveUpdateCandidatePluginSourcePath(privateRoot, source);
        return original ? [JSON.stringify([original, specifier])] : [];
      }),
    );
    const canonicalSource = await fs.realpath(entryFile).catch((error: unknown) => {
      if (hasNodeErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (!canonicalSource) {
      warnings.push(`Plugin source for update checks is no longer available: ${entryFile}.`);
      continue;
    }
    let available: ReturnType<typeof inspectPluginSourceDependencies>;
    try {
      available = inspectPluginSourceDependencies([{ rootDir, entryFile }]);
    } catch {
      // Source edits cannot invalidate an already runnable copy. Without a
      // supplied missing edge, candidate execution still owns optional imports.
      warnings.push(`Update checks could not inspect the original plugin source: ${entryFile}.`);
      continue;
    }
    if (
      !available.references.some(({ source, specifier }) =>
        missingReferences.has(JSON.stringify([source, specifier])),
      )
    ) {
      continue;
    }
    if (canonicalSource !== entryFile || (await fs.realpath(rootDir)) !== rootDir) {
      throw new Error(`Plugin source location changed since the update snapshot: ${entryFile}.`);
    }
    for (const [source, copied] of [
      [entryFile, copiedEntry],
      [path.join(rootDir, "package.json"), path.join(copiedRoot, "package.json")],
      [path.join(rootDir, "openclaw.plugin.json"), path.join(copiedRoot, "openclaw.plugin.json")],
    ] as const) {
      await assertMatchingFile(source, copied);
      comparedFiles.set(source, copied);
    }
    available.assertSourceCurrent();
    originals.push({ rootDir, entryFile });
  }
  if (originals.length === 0) {
    return { copiedFiles: 0, warnings };
  }
  const graph = inspectPluginSourceDependencies(originals);
  for (const source of graph.files) {
    const copied = project(source);
    assertPrivate(copied);
    if (await readOptionalFile(copied)) {
      comparedFiles.set(source, copied);
    }
  }
  const assertCurrent = async () => {
    if (
      params.env.OPENCLAW_UPDATE_IN_PROGRESS !== "1" ||
      resolveUpdateRehearsalRoot(params.env) !== rehearsalRoot
    ) {
      throw new Error("Update authority changed during plugin dependency preparation");
    }
    graph.assertSourceCurrent();
    for (const [source, copied] of comparedFiles) {
      await assertMatchingFile(source, copied);
    }
    graph.assertSourceCurrent();
  };
  await assertCurrent();
  const plan = await prepareUpdateCandidatePluginTrees({
    roots: new Map(
      [...graph.packageRoots, ...graph.files].map((source) => [source, project(source)]),
    ),
    project,
    targetStateDir: privateRoot,
    candidateRoot,
  });
  const missing: typeof plan.entries = [];
  for (const entry of plan.entries) {
    const destination = project(entry.path);
    assertPrivate(destination);
    const existing = await fs.lstat(destination).catch((error: unknown) => {
      if (hasNodeErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (!existing) {
      missing.push(entry);
    } else if (
      (entry.kind === "directory" && !existing.isDirectory()) ||
      (entry.kind === "file" && !existing.isFile()) ||
      (entry.kind === "symlink" && !existing.isSymbolicLink())
    ) {
      throw new Error(
        `Plugin dependency conflicts with the existing update snapshot: ${destination}`,
      );
    }
  }
  await assertCurrent();
  if (missing.length > 0) {
    await copyUpdateCandidatePluginTrees(
      { ...plan, entries: missing },
      {
        targetStateDir: privateRoot,
        candidateRoot,
      },
    );
    await assertCurrent();
  }
  return { copiedFiles: missing.filter((entry) => entry.kind === "file").length, warnings };
}
