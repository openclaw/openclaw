import fs from "node:fs";
import path from "node:path";
import { isMissingPathError } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.types.js";
import {
  pluginCacheExistsSync,
  pluginCacheLstatSync,
  pluginCacheRealpathSync,
  readPluginCacheDirectory,
} from "../../plugins/plugin-cache-files.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../../plugins/plugin-metadata-lifecycle.js";
import { isPathInside } from "../../security/scan-paths.js";
import type { PluginSkillRoot } from "./plugin-skill-root.js";
import { resolvePluginSkillsDir } from "./skill-paths.js";

const log = createSubsystemLogger("skills");

/** Serializable active contributions; filesystem validation remains with the skill owner. */
export type PluginSkillContribution = Pick<
  PluginManifestRecord,
  "id" | "origin" | "rootDir" | "bundleFormat"
> & { roots: string[] };

// This tracks the generated SDK links we last published, not plugin metadata.
// Config and ACP availability can change the desired links without changing package files.
let lastDefaultPluginSkillsPublication: {
  directory: string;
  targets: ReadonlyMap<string, string>;
} | null = null;

registerPluginMetadataProcessMemoLifecycleClear(() => {
  lastDefaultPluginSkillsPublication = null;
});

/** Validate and publish selected roots on the filesystem-owning thread. */
export function resolvePluginSkillRootsFromContributions(params: {
  contributions: readonly PluginSkillContribution[];
  pluginSkillsDir?: string;
}): PluginSkillRoot[] {
  const seen = new Set<string>();
  const resolved: PluginSkillRoot[] = [];

  for (const record of params.contributions) {
    const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
      origin: record.origin,
      rootDir: record.rootDir,
    });
    for (const raw of record.roots) {
      const trimmed = raw.trim();
      if (!trimmed) {
        continue;
      }
      const candidate = path.resolve(record.rootDir, trimmed);
      if (!pluginCacheExistsSync(candidate)) {
        log.warn(`plugin skill path not found (${record.id}): ${candidate}`);
        continue;
      }
      if (!isPluginSkillPathInside(record.rootDir, candidate)) {
        log.warn(`plugin skill path escapes plugin root (${record.id}): ${candidate}`);
        continue;
      }
      const candidates =
        record.bundleFormat === "agent" ? collectAgentSkillTargets(candidate) : [candidate];
      for (const resolvedCandidate of candidates) {
        if (seen.has(resolvedCandidate)) {
          continue;
        }
        seen.add(resolvedCandidate);
        resolved.push({ dir: resolvedCandidate, rejectHardlinks });
      }
    }
  }

  publishPluginSkills(
    resolved.map((root) => root.dir),
    params.pluginSkillsDir,
  );

  return resolved;
}

export function isPluginSkillPathInside(rootDir: string, candidate: string): boolean {
  if (!isPathInside(rootDir, candidate)) {
    return false;
  }
  const rootRealPath = pluginCacheRealpathSync(rootDir);
  const candidateRealPath = pluginCacheRealpathSync(candidate);
  return Boolean(
    rootRealPath && candidateRealPath && isPathInside(rootRealPath, candidateRealPath),
  );
}

function listSkillChildDirectories(dir: string): Array<{ name: string; path: string }> {
  try {
    return readPluginCacheDirectory(dir)
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }));
  } catch {
    return [];
  }
}

function collectAgentSkillTargets(skillsRoot: string): string[] {
  const targets: string[] = [];
  for (const entry of listSkillChildDirectories(skillsRoot)) {
    if (hasPublishableSkillFile({ skillDir: entry.path, rootDir: skillsRoot })) {
      targets.push(entry.path);
      continue;
    }
    log.warn(`agent plugin skill skipped because SKILL.md is missing or invalid: ${entry.path}`);
  }
  return targets;
}

function collectSkillTargets(dir: string, targets: Map<string, string>): void {
  const candidates = hasPublishableSkillFile({ skillDir: dir, rootDir: dir })
    ? [{ name: path.basename(dir), path: dir }]
    : listSkillChildDirectories(dir).filter((entry) =>
        hasPublishableSkillFile({ skillDir: entry.path, rootDir: dir }),
      );
  for (const entry of candidates) {
    const existing = targets.get(entry.name);
    if (existing) {
      log.warn(
        `plugin skill name collision: "${entry.name}" resolves to both ${existing} and ${entry.path}; ` +
          `only the first will be published`,
      );
      continue;
    }
    targets.set(entry.name, entry.path);
  }
}

function hasPublishableSkillFile(params: { skillDir: string; rootDir: string }): boolean {
  const skillMd = path.join(params.skillDir, "SKILL.md");
  const skillMdStat = pluginCacheLstatSync(skillMd);
  if (!skillMdStat) {
    return false;
  }
  if (!skillMdStat.isFile() || skillMdStat.isSymbolicLink()) {
    log.warn(`plugin skill SKILL.md is not a regular file: ${skillMd}`);
    return false;
  }
  if (!isPluginSkillPathInside(params.rootDir, skillMd)) {
    log.warn(`plugin skill SKILL.md escapes declared skill root: ${skillMd}`);
    return false;
  }
  return true;
}

/**
 * Creates symlinks from each resolved plugin skill directory into the
 * plugin skills directory (~/.openclaw/plugin-skills/) so the agent SDK can
 * discover them at the conventional file-system path.
 *
 * The plugin-skills directory is fully owned by OpenClaw — every entry is
 * a generated symlink. Cleanup of stale links is therefore safe.
 */
export function publishPluginSkills(skillDirs: string[], directory?: string): void {
  const pluginSkillsDir = directory ?? resolvePluginSkillsDir();
  const managedTargets = new Map<string, string>();

  for (const dir of skillDirs) {
    collectSkillTargets(dir, managedTargets);
  }

  if (
    directory === undefined &&
    lastDefaultPluginSkillsPublication?.directory === pluginSkillsDir &&
    lastDefaultPluginSkillsPublication.targets.size === managedTargets.size &&
    [...managedTargets].every(
      ([name, target]) => lastDefaultPluginSkillsPublication?.targets.get(name) === target,
    )
  ) {
    return;
  }

  // Plugin skill symlinks are owned by OpenClaw and publish at extra-dir
  // precedence, so they never shadow managed or bundled skills.
  for (const [name, target] of managedTargets) {
    const linkPath = path.join(pluginSkillsDir, name);
    try {
      fs.mkdirSync(pluginSkillsDir, { recursive: true });
    } catch {
      // best-effort; symlink will fail below if dir is truly unusable
    }
    try {
      const existingEntry = fs.lstatSync(linkPath);
      if (existingEntry.isSymbolicLink()) {
        const existingTarget = fs.readlinkSync(linkPath);
        if (existingTarget === target) {
          continue;
        }
        removeGeneratedPluginSkillEntry(linkPath);
      } else if (isGeneratedPluginSkillEntry(existingEntry)) {
        removeGeneratedPluginSkillEntry(linkPath);
      } else {
        log.warn(`plugin skill entry is not a generated symlink: ${linkPath}`);
        continue;
      }
    } catch (err) {
      if (!isMissingPathError(err)) {
        log.warn(`failed to inspect plugin skill symlink "${linkPath}": ${String(err)}`);
        continue;
      }
    }
    try {
      fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch (err) {
      log.warn(`failed to create plugin skill symlink "${linkPath}" → "${target}": ${String(err)}`);
    }
  }

  let existingEntries: fs.Dirent[];
  try {
    existingEntries = fs.readdirSync(pluginSkillsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of existingEntries) {
    if (!isGeneratedPluginSkillEntry(entry)) {
      continue;
    }
    if (managedTargets.has(entry.name)) {
      continue;
    }
    const linkPath = path.join(pluginSkillsDir, entry.name);
    removeGeneratedPluginSkillEntry(linkPath);
  }
  if (directory === undefined) {
    lastDefaultPluginSkillsPublication = { directory: pluginSkillsDir, targets: managedTargets };
  }
}

function isGeneratedPluginSkillEntry(
  entry: Pick<fs.Dirent, "isDirectory" | "isSymbolicLink">,
): boolean {
  // Windows directory symlinks are junctions and lstat reports them as directories.
  return entry.isSymbolicLink() || (process.platform === "win32" && entry.isDirectory());
}

function removeGeneratedPluginSkillEntry(linkPath: string): void {
  try {
    const entry = fs.lstatSync(linkPath);
    if (entry.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
      return;
    }
  } catch (err) {
    if (isMissingPathError(err)) {
      return;
    }
  }
  try {
    fs.rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}
