// Sandbox workspace skill synchronization is deferred behind the sandbox runtime boundary.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSandboxPath } from "../../agents/sandbox-paths.js";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { tryReadJson, writeJson } from "../../infra/json-files.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { loadSkillLibrarySelection, readSelectedSkillLibraryFiles } from "../library/selection.js";
import { getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { fingerprintSkillSnapshotConfig } from "../runtime/snapshot-config-fingerprint.js";
import type {
  SkillEligibilityContext,
  SkillEntry,
  SkillSnapshot,
  SkillUsagePath,
} from "../types.js";
import { resolveSkillKey } from "./frontmatter.js";
import { serializeByKey } from "./serialize.js";
import { shouldSyncSkillPath } from "./skill-paths.js";
import { resolveSkillTelemetrySource } from "./source.js";
import { prepareWorkspaceSkills } from "./workspace-skill-loader.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";

const fsp = fs.promises;
const skillsLogger = createSubsystemLogger("skills");

function resolveUniqueSyncedSkillDirName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

const SYNCED_SKILLS_MANIFEST_NAME = ".openclaw-sync.json";

type SyncedSkillsManifest = {
  entryKeys: string[];
  skillRootsFingerprint: string;
  skillsVersion: number;
};

const syncedSkillsUsageCache = new Map<
  string,
  {
    destinations: Map<string, string>;
    manifestKey: string;
    skillUsagePaths: SkillUsagePath[];
  }
>();

function resolveSyncedSkillIdentity(skillKey: string, skillName: string): string {
  return JSON.stringify([skillKey, skillName]);
}

function parseSyncedSkillsManifest(value: unknown): SyncedSkillsManifest | null {
  if (
    !isRecord(value) ||
    typeof value.skillsVersion !== "number" ||
    !Number.isFinite(value.skillsVersion) ||
    typeof value.skillRootsFingerprint !== "string" ||
    !Array.isArray(value.entryKeys) ||
    !value.entryKeys.every((entry) => typeof entry === "string")
  ) {
    return null;
  }
  return {
    entryKeys: value.entryKeys,
    skillRootsFingerprint: value.skillRootsFingerprint,
    skillsVersion: value.skillsVersion,
  };
}

function resolveSyncedSkillsManifestKey(manifest: SyncedSkillsManifest): string {
  return JSON.stringify([
    manifest.skillsVersion,
    manifest.skillRootsFingerprint,
    manifest.entryKeys,
  ]);
}

function resolveSyncedSkillDestinationPath(params: {
  targetSkillsDir: string;
  entry: SkillEntry;
  usedDirNames: Set<string>;
}): string | null {
  const sourceDirName = (
    params.entry.syncDirName ?? path.basename(params.entry.skill.baseDir)
  ).trim();
  if (!sourceDirName || sourceDirName === "." || sourceDirName === "..") {
    return null;
  }
  const uniqueDirName = resolveUniqueSyncedSkillDirName(sourceDirName, params.usedDirNames);
  return resolveSandboxPath({
    filePath: uniqueDirName,
    cwd: params.targetSkillsDir,
    root: params.targetSkillsDir,
  }).resolved;
}

async function ensureSyncedSkillsDirectory(targetSkillsDir: string): Promise<void> {
  let stats: fs.Stats;
  try {
    stats = await fsp.lstat(targetSkillsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await fsp.mkdir(targetSkillsDir, { recursive: true });
    return;
  }

  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    await fsp.rm(targetSkillsDir, { recursive: true, force: true });
    await fsp.mkdir(targetSkillsDir, { recursive: true });
  }
}

type SyncWorkspaceSkillsParams = {
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
  config?: OpenClawConfig;
  skillFilter?: string[];
  agentId?: string;
  eligibility?: SkillEligibilityContext;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
  pluginSkillsDir?: string;
  skillsSnapshot?: SkillSnapshot;
};

export async function syncWorkspaceSkills(
  params: SyncWorkspaceSkillsParams,
): Promise<SkillUsagePath[]> {
  return materializeWorkspaceSkills(params);
}

async function materializeWorkspaceSkills(
  params: SyncWorkspaceSkillsParams,
  onPublished?: (entries: SkillEntry[], version: number) => Promise<void>,
): Promise<SkillUsagePath[]> {
  const sourceDir = resolveUserPath(params.sourceWorkspaceDir);
  const targetDir = resolveUserPath(params.targetWorkspaceDir);
  if (sourceDir === targetDir) {
    return [];
  }

  return await serializeByKey(`syncSkills:${targetDir}`, async () => {
    const targetSkillsDir = path.join(targetDir, "skills");
    const manifestPath = path.join(targetSkillsDir, SYNCED_SKILLS_MANIFEST_NAME);
    const skillsSnapshot = params.skillsSnapshot;
    const skillRoots = skillsSnapshot?.skillRoots;
    // Names and versions do not identify a source tree. Both reuse paths must
    // bind its full discovery context, or shared sandboxes retain another owner's bytes.
    const skillRootsFingerprint = sha256Hex(
      JSON.stringify([
        sourceDir,
        params.agentId ? normalizeAgentId(params.agentId) : undefined,
        params.config ? fingerprintSkillSnapshotConfig(params.config) : undefined,
        params.managedSkillsDir,
        params.bundledSkillsDir,
        params.pluginSkillsDir,
        skillRoots?.agentWorkspaceDir,
        skillRoots?.executionWorkspaceDir,
        skillsSnapshot?.librarySelections,
      ]),
    );
    await ensureSyncedSkillsDirectory(targetSkillsDir);
    const manifest = parseSyncedSkillsManifest(await tryReadJson<unknown>(manifestPath));
    let skillsVersion = getSkillsSnapshotVersion(skillRoots?.agentWorkspaceDir ?? sourceDir);
    const expectedManifestKey =
      skillsSnapshot?.version === skillsVersion
        ? resolveSyncedSkillsManifestKey({
            entryKeys: skillsSnapshot.skills
              .map((skill) => resolveSyncedSkillIdentity(skill.skillKey ?? skill.name, skill.name))
              .toSorted(),
            skillRootsFingerprint,
            skillsVersion,
          })
        : undefined;
    const cachedUsage = syncedSkillsUsageCache.get(targetSkillsDir);
    const manifestKey = manifest ? resolveSyncedSkillsManifestKey(manifest) : undefined;
    if (
      expectedManifestKey &&
      manifestKey === expectedManifestKey &&
      cachedUsage?.manifestKey === manifestKey
    ) {
      return cachedUsage.skillUsagePaths.map((entry) => ({ ...entry }));
    }

    const loadOptions = {
      config: params.config,
      skillFilter: params.skillFilter,
      agentId: params.agentId,
      eligibility: params.eligibility,
      managedSkillsDir: params.managedSkillsDir,
      bundledSkillsDir: params.bundledSkillsDir,
      pluginSkillsDir: params.pluginSkillsDir,
      ...(skillsSnapshot?.skillFilter ? { skillFilter: skillsSnapshot.skillFilter } : {}),
      ...(skillsSnapshot?.skillOverrides ? { skillOverrides: skillsSnapshot.skillOverrides } : {}),
    };
    let entries: SkillEntry[];
    for (;;) {
      skillsVersion = getSkillsSnapshotVersion(skillRoots?.agentWorkspaceDir ?? sourceDir);
      entries = await prepareWorkspaceSkills(skillRoots?.agentWorkspaceDir ?? sourceDir, {
        ...loadOptions,
        executionWorkspaceDir: skillRoots?.executionWorkspaceDir,
      });
      if (getSkillsSnapshotVersion(skillRoots?.agentWorkspaceDir ?? sourceDir) === skillsVersion) {
        break;
      }
    }
    if (skillsSnapshot?.librarySelections?.length) {
      const selectedNames = new Set(skillsSnapshot.skills.map((skill) => skill.name));
      entries.push(
        ...loadSkillLibrarySelection(skillsSnapshot.librarySelections).filter((entry) =>
          selectedNames.has(entry.skill.name),
        ),
      );
    }

    const usedDirNames = new Set<string>([".openclaw-catalogs"]);
    const plans: Array<{ destinationPath?: string; entry: SkillEntry; identity: string }> = [];
    for (const entry of entries) {
      const identity = resolveSyncedSkillIdentity(
        resolveSkillKey(entry.skill, entry),
        entry.skill.name,
      );
      if (entry.skill.filePath.startsWith("node://")) {
        plans.push({ entry, identity });
        continue;
      }
      let destinationPath: string | null;
      try {
        destinationPath = resolveSyncedSkillDestinationPath({
          targetSkillsDir,
          entry,
          usedDirNames,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        skillsLogger.warn(`Failed to resolve safe destination for ${entry.skill.name}: ${message}`);
        continue;
      }
      if (!destinationPath) {
        skillsLogger.warn(
          `Failed to resolve safe destination for ${entry.skill.name}: invalid source directory name`,
        );
        continue;
      }
      plans.push({ destinationPath, entry, identity });
    }

    await fsp.rm(manifestPath, { force: true });
    const previousUsage =
      manifest?.skillsVersion === skillsVersion &&
      manifest.skillRootsFingerprint === skillRootsFingerprint &&
      cachedUsage?.manifestKey === manifestKey
        ? cachedUsage
        : undefined;
    syncedSkillsUsageCache.delete(targetSkillsDir);
    const preservedDestinations = new Set(
      plans.flatMap((plan) => {
        const destination = plan.destinationPath ? path.basename(plan.destinationPath) : null;
        return previousUsage?.destinations.get(plan.identity) === destination
          ? destination
            ? [destination]
            : []
          : [];
      }),
    );
    for (const child of await fsp.readdir(targetSkillsDir)) {
      if (child !== ".openclaw-catalogs" && !preservedDestinations.has(child)) {
        await fsp.rm(path.join(targetSkillsDir, child), { recursive: true, force: true });
      }
    }

    const skillUsagePaths: SkillUsagePath[] = [];
    const publishedEntries: SkillEntry[] = [];
    let copyFailed = false;
    for (const plan of plans) {
      const { destinationPath, entry } = plan;
      if (!destinationPath) {
        publishedEntries.push(entry);
        continue;
      }
      if (!preservedDestinations.has(path.basename(destinationPath))) {
        try {
          const pin = skillsSnapshot?.librarySelections?.find(
            (selection) => selection.name === entry.skill.name,
          );
          if (pin) {
            const files = await readSelectedSkillLibraryFiles(pin);
            for (const file of files) {
              const target = path.join(destinationPath, file.path);
              await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
              await fsp.writeFile(
                target,
                Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8"),
                { mode: file.executable ? 0o500 : 0o400, flag: "wx" },
              );
            }
          } else {
            const syncSourceDir = entry.syncSourceDir ?? entry.skill.baseDir;
            await fsp.cp(syncSourceDir, destinationPath, {
              recursive: true,
              force: true,
              filter: shouldSyncSkillPath,
            });
          }
        } catch (error) {
          if (onPublished || entry.skill.source === "openclaw-library") {
            throw error;
          }
          copyFailed = true;
          const message = error instanceof Error ? error.message : JSON.stringify(error);
          skillsLogger.warn(`Failed to copy ${entry.skill.name} to sandbox: ${message}`);
          continue;
        }
      }
      const filePath = path.join(
        destinationPath,
        path.relative(entry.skill.baseDir, entry.skill.filePath),
      );
      publishedEntries.push({
        ...entry,
        skill: {
          ...entry.skill,
          baseDir: destinationPath,
          filePath,
          sourceInfo: {
            ...entry.skill.sourceInfo,
            path: filePath,
            ...(entry.skill.sourceInfo.baseDir === undefined ? {} : { baseDir: destinationPath }),
          },
        },
      });
      skillUsagePaths.push({
        readPath: path.join(
          destinationPath,
          path.relative(entry.skill.baseDir, entry.skill.filePath),
        ),
        skillFile: canonicalizePath(entry.skill.filePath),
        skillName: entry.skill.name,
        skillSource: resolveSkillTelemetrySource(entry.skill),
      });
    }
    if (
      onPublished &&
      getSkillsSnapshotVersion(skillRoots?.agentWorkspaceDir ?? sourceDir) !== skillsVersion
    ) {
      throw new Error("Skills changed while materializing the sandbox catalog.");
    }
    await onPublished?.(publishedEntries, skillsVersion);
    if (!copyFailed) {
      const nextManifest: SyncedSkillsManifest = {
        entryKeys: plans.map((plan) => plan.identity).toSorted(),
        skillRootsFingerprint,
        skillsVersion,
      };
      await writeJson(manifestPath, nextManifest, { trailingNewline: true });
      syncedSkillsUsageCache.set(targetSkillsDir, {
        destinations: new Map(
          plans.flatMap((plan) =>
            plan.destinationPath
              ? [[plan.identity, path.basename(plan.destinationPath)] as const]
              : [],
          ),
        ),
        manifestKey: resolveSyncedSkillsManifestKey(nextManifest),
        skillUsagePaths,
      });
      pruneMapToMaxSize(syncedSkillsUsageCache, 100);
    }
    return skillUsagePaths;
  });
}

export type PublishedWorkspaceSkills = {
  skillUsagePaths: SkillUsagePath[];
  skillsSnapshot: SkillSnapshot;
  release: () => Promise<void>;
};

/** Normalize only the private exported copy, never sources or symlink targets. */
async function makePublishedSkillsReadable(directory: string): Promise<void> {
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await makePublishedSkillsReadable(target);
      await fsp.chmod(target, 0o755);
    } else if (entry.isFile()) {
      const mode = (await fsp.lstat(target)).mode;
      await fsp.chmod(target, mode & 0o111 ? 0o555 : 0o444);
    }
  }
}

/** Materialize a complete, immutable catalog owned by one execution, not a generation count. */
export async function acquireWorkspaceSkills(
  params: SyncWorkspaceSkillsParams,
): Promise<PublishedWorkspaceSkills> {
  // Stay under the existing read-only skills bind mount; never replace its mounted inode.
  const skillsRoot = path.join(resolveUserPath(params.targetWorkspaceDir), "skills");
  await ensureSyncedSkillsDirectory(skillsRoot);
  const root = path.join(skillsRoot, ".openclaw-catalogs");
  await ensureSyncedSkillsDirectory(root);
  const publicationDir = await fsp.mkdtemp(path.join(root, "run-"));
  let releasePending: Promise<void> | undefined;
  const release = () => {
    releasePending ??= fsp
      .rm(publicationDir, { recursive: true, force: true })
      .then(() => {
        syncedSkillsUsageCache.delete(path.join(publicationDir, "skills"));
      })
      .catch((error: unknown) => {
        releasePending = undefined;
        throw error;
      });
    return releasePending;
  };
  try {
    let skillsSnapshot: SkillSnapshot | undefined;
    const explicitlyEmpty = params.skillsSnapshot && !params.skillsSnapshot.prompt.trim();
    const skillUsagePaths =
      explicitlyEmpty && params.skillsSnapshot?.skills.length === 0
        ? []
        : await materializeWorkspaceSkills(
            { ...params, targetWorkspaceDir: publicationDir },
            async (entries, version) => {
              skillsSnapshot = await buildSkillSnapshot(publicationDir, {
                entries,
                config: params.config,
                agentId: params.agentId,
                skillFilter: params.skillsSnapshot?.skillFilter ?? params.skillFilter,
                skillOverrides: params.skillsSnapshot?.skillOverrides,
                eligibility: params.eligibility,
                snapshotVersion: version,
              });
              if (params.skillsSnapshot?.librarySelections) {
                skillsSnapshot.librarySelections = params.skillsSnapshot.librarySelections;
              }
            },
          );
    if (explicitlyEmpty) {
      skillsSnapshot = { ...params.skillsSnapshot!, resolvedSkills: [] };
    }
    if (!skillsSnapshot) {
      throw new Error("Sandbox skill catalog was not published.");
    }
    // Preserve traversal through the read-only mount for an explicitly configured container UID.
    // Staging stays private until every file and the complete prompt are ready.
    await makePublishedSkillsReadable(publicationDir);
    await fsp.chmod(publicationDir, 0o755);
    return { skillUsagePaths, skillsSnapshot, release };
  } catch (error) {
    try {
      await release();
    } catch {
      /* Retain the materialization failure. */
    }
    throw error;
  }
}
