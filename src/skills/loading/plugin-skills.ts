import path from "node:path";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import {
  pluginCacheExistsSync,
  pluginCacheRealpathSync,
} from "../../plugins/plugin-cache-files.js";
import { getPluginMetadataSnapshotCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { resolvePluginMetadataSnapshotRequiredRuntime } from "../../plugins/plugin-metadata-snapshot-required.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { iteratePluginRootContributions } from "../../plugins/plugin-root-contributions.js";
import {
  isPluginSkillPathInside,
  publishPluginSkills,
  resolvePluginSkillRootsFromContributions,
  type PluginSkillContribution,
} from "./plugin-skill-publication.js";
import type { PluginSkillRoot } from "./plugin-skill-root.js";
import { loadSkillRootRecords } from "./skill-root-loader.js";

export type { PluginSkillRoot } from "./plugin-skill-root.js";

const log = createSubsystemLogger("skills");

export function resolvePluginSkillRoots(params: {
  workspaceDir: string | undefined;
  config?: OpenClawConfig;
  /** Override the plugin skills directory for testing. */
  pluginSkillsDir?: string;
  acpRuntimeAvailable?: boolean;
}): PluginSkillRoot[] {
  const workspaceDir = (params.workspaceDir ?? "").trim();
  if (!workspaceDir || params.config?.plugins?.enabled === false) {
    publishPluginSkills([], params.pluginSkillsDir);
    return [];
  }
  const metadataSnapshot = resolvePluginMetadataSnapshotRequiredRuntime({
    workspaceDir,
    config: params.config,
    env: process.env,
  });
  return resolvePluginSkillRootsFromMetadata({ ...params, metadataSnapshot });
}

export function resolvePluginSkillRootsFromMetadata(params: {
  workspaceDir: string | undefined;
  config?: OpenClawConfig;
  pluginSkillsDir?: string;
  metadataSnapshot: PluginMetadataSnapshot;
  acpRuntimeAvailable?: boolean;
}): PluginSkillRoot[] {
  return withPluginCache(getPluginMetadataSnapshotCache(params.metadataSnapshot), () =>
    resolvePluginSkillRootsInOwner(params),
  );
}

function resolvePluginSkillRootsInOwner(
  params: Parameters<typeof resolvePluginSkillRootsFromMetadata>[0],
): PluginSkillRoot[] {
  const workspaceDir = (params.workspaceDir ?? "").trim();
  if (!workspaceDir) {
    publishPluginSkills([], params.pluginSkillsDir);
    return [];
  }
  return resolvePluginSkillRootsFromContributions({
    contributions: capturePluginSkillContributions(params),
    pluginSkillsDir: params.pluginSkillsDir,
  });
}

/** Select activation and ACP policy without reading plugin directories. */
export function capturePluginSkillContributions(params: {
  config?: OpenClawConfig;
  metadataSnapshot: PluginMetadataSnapshot;
  acpRuntimeAvailable?: boolean;
}): PluginSkillContribution[] {
  const config = params.config ?? {};
  const acpRuntimeAvailable = params.acpRuntimeAvailable ?? isAcpRuntimeSpawnAvailable({ config });
  return [
    ...iteratePluginRootContributions({
      metadataSnapshot: params.metadataSnapshot,
      config,
      contribution: "skills",
      isAvailable: (candidate) => acpRuntimeAvailable || candidate.id !== "acpx",
    }),
  ].map(({ record, roots }) => ({
    id: record.id,
    origin: record.origin,
    rootDir: record.rootDir,
    bundleFormat: record.bundleFormat,
    roots,
  }));
}

/** Folder names of active plugins' per-agent learned skills; each agent's state folder anchors them. */
export function capturePluginAgentSkillsDirs(params: {
  config?: OpenClawConfig;
  metadataSnapshot: PluginMetadataSnapshot;
}): string[] {
  const contributions = iteratePluginRootContributions({
    metadataSnapshot: params.metadataSnapshot,
    config: params.config ?? {},
    contribution: "agentSkillsDir",
  });
  return [...new Set([...contributions].flatMap(({ roots }) => roots))];
}

export function resolvePluginAgentSkillsDirs(params: {
  workspaceDir: string | undefined;
  config?: OpenClawConfig;
}): string[] {
  const workspaceDir = (params.workspaceDir ?? "").trim();
  if (!workspaceDir || params.config?.plugins?.enabled === false) {
    return [];
  }
  return capturePluginAgentSkillsDirs({
    config: params.config,
    metadataSnapshot: resolvePluginMetadataSnapshotRequiredRuntime({
      workspaceDir,
      config: params.config,
      env: process.env,
    }),
  });
}

/** Resolve manifest skill roots to the names users and agents actually see. */
function resolvePluginSkillRecords(
  record: Pick<PluginManifestRecord, "id" | "origin" | "rootDir" | "skills">,
) {
  const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
    origin: record.origin,
    rootDir: record.rootDir,
  });
  const records = new Map<string, ReturnType<typeof loadSkillRootRecords>[number]>();
  for (const raw of record.skills) {
    const candidate = path.resolve(record.rootDir, raw.trim());
    if (!raw.trim() || !pluginCacheExistsSync(candidate)) {
      continue;
    }
    if (!isPluginSkillPathInside(record.rootDir, candidate)) {
      log.warn(`plugin skill path escapes plugin root (${record.id}): ${candidate}`);
      continue;
    }
    for (const loaded of loadSkillRootRecords({
      dir: candidate,
      source: record.origin === "bundled" ? "bundled" : "plugin",
      mode: "audit",
      rejectHardlinks,
    })) {
      records.set(loaded.skill.filePath, loaded);
    }
  }
  return [...records.values()];
}

export function resolvePluginSkillDetails(
  record: Pick<PluginManifestRecord, "id" | "origin" | "rootDir" | "skills">,
): Array<{ name: string; description?: string }> {
  return [
    ...new Map(
      resolvePluginSkillRecords(record).map(({ skill }) => [
        skill.name,
        {
          name: skill.name,
          ...(skill.description ? { description: skill.description } : {}),
        },
      ]),
    ).values(),
  ].toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function readPluginSkill(
  record: Pick<PluginManifestRecord, "id" | "origin" | "rootDir" | "skills" | "version">,
  name: string,
  selection?: { path?: string; version?: string },
) {
  if (selection?.version !== undefined && selection.version !== record.version) {
    throw new Error("Installed plugin version changed. Reopen the skill preview.");
  }
  const matches = resolvePluginSkillRecords(record).filter(({ skill }) => skill.name === name);
  if (matches.length !== 1) {
    throw new Error(matches.length ? "Plugin skill name is ambiguous." : "Plugin skill not found.");
  }
  // Audit discovery returns real paths; relativize against the same root identity.
  const pluginRoot = pluginCacheRealpathSync(record.rootDir);
  if (!pluginRoot) {
    throw new Error("Installed plugin root not found.");
  }
  const { readPluginSkillBundle } = await import("./plugin-skill-bundle.js");
  const result = await readPluginSkillBundle({
    pluginRoot,
    rootPath: path.relative(pluginRoot, matches[0]!.skill.baseDir).split(path.sep).join("/") || ".",
    name,
    rejectHardlinks: shouldRejectHardlinkedPluginFiles(record),
    path: selection?.path,
  });
  return { ...result, ...(record.version ? { version: record.version } : {}) };
}
