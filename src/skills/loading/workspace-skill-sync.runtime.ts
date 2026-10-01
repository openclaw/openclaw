// Sandbox workspace skill synchronization is deferred behind the sandbox runtime boundary.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSandboxPath } from "../../agents/sandbox-paths.js";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { tryReadJson, writeJson } from "../../infra/json-files.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { loadSkillLibrarySelection, readSelectedSkillLibraryFiles } from "../library/selection.js";
import { getSkillsSnapshotVersion, getSkillsResourceVersion } from "../runtime/refresh-state.js";
import { fingerprintSkillSnapshotConfig } from "../runtime/snapshot-config-fingerprint.js";
import type {
  SkillEligibilityContext,
  SkillEntry,
  SkillSnapshot,
  SkillUsagePath,
} from "../types.js";
import { resolveSkillKey } from "./frontmatter.js";
import { ensureWritableSkillDirectories } from "./skill-directory-modes.js";
import { shouldSyncSkillPath } from "./skill-paths.js";
import { resolveSkillTelemetrySource } from "./source.js";
import { prepareWorkspaceSkills } from "./workspace-skill-loader.js";

const fsp = fs.promises;
const skillsLogger = createSubsystemLogger("skills");
const skillsSyncQueue = new KeyedAsyncQueue();

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
    sourceVersion: number;
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

async function ensureSyncedSkillsDirectory(targetSkillsDir: string): Promise<void> {
  try {
    if ((await fsp.lstat(targetSkillsDir)).isDirectory()) {
      return;
    }
    await fsp.rm(targetSkillsDir, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await fsp.mkdir(targetSkillsDir, { recursive: true });
}

export async function syncWorkspaceSkills(params: {
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
}): Promise<SkillUsagePath[]> {
  const sourceDir = resolveUserPath(params.sourceWorkspaceDir);
  const targetDir = resolveUserPath(params.targetWorkspaceDir);
  if (sourceDir === targetDir) {
    return [];
  }

  return await skillsSyncQueue.enqueue(`syncSkills:${targetDir}`, async () => {
    const targetSkillsDir = path.join(targetDir, "skills");
    const manifestPath = path.join(targetSkillsDir, SYNCED_SKILLS_MANIFEST_NAME);
    const skillsSnapshot = params.skillsSnapshot;
    const skillRoots = skillsSnapshot?.skillRoots;
    const sourceWorkspace = skillRoots?.agentWorkspaceDir ?? sourceDir;
    const sourceScope = {
      executionWorkspaceDir: skillRoots?.executionWorkspaceDir,
      agentId: params.agentId,
    };
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
    let sourceVersion = getSkillsResourceVersion(sourceWorkspace, sourceScope);
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
      cachedUsage?.manifestKey === manifestKey &&
      cachedUsage.sourceVersion === sourceVersion
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
      sourceVersion = getSkillsResourceVersion(sourceWorkspace, sourceScope);
      skillsVersion = getSkillsSnapshotVersion(skillRoots?.agentWorkspaceDir ?? sourceDir);
      entries = await prepareWorkspaceSkills(skillRoots?.agentWorkspaceDir ?? sourceDir, {
        ...loadOptions,
        executionWorkspaceDir: skillRoots?.executionWorkspaceDir,
      });
      if (
        getSkillsSnapshotVersion(sourceWorkspace) === skillsVersion &&
        getSkillsResourceVersion(sourceWorkspace, sourceScope) === sourceVersion
      ) {
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

    const usedDirNames = new Set<string>();
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
      let destinationPath: string;
      try {
        const base = (entry.syncDirName ?? path.basename(entry.skill.baseDir)).trim();
        if (!base || base === "." || base === "..") {
          throw new Error("invalid source directory name");
        }
        let name = base;
        for (let index = 2; usedDirNames.has(name); index += 1) {
          name = `${base}-${index}`;
        }
        usedDirNames.add(name);
        destinationPath = resolveSandboxPath({
          filePath: name,
          cwd: targetSkillsDir,
          root: targetSkillsDir,
        }).resolved;
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        skillsLogger.warn(`Failed to resolve safe destination for ${entry.skill.name}: ${message}`);
        continue;
      }
      plans.push({ destinationPath, entry, identity });
    }

    await fsp.rm(manifestPath, { force: true });
    const previousUsage =
      cachedUsage &&
      manifest?.skillsVersion === skillsVersion &&
      manifest.skillRootsFingerprint === skillRootsFingerprint &&
      cachedUsage.manifestKey === manifestKey &&
      cachedUsage.sourceVersion === sourceVersion
        ? cachedUsage
        : undefined;
    syncedSkillsUsageCache.delete(targetSkillsDir);
    const preservedDestinations = new Set(
      plans.flatMap((plan) => {
        const destination = plan.destinationPath ? path.basename(plan.destinationPath) : null;
        return destination && previousUsage?.destinations.get(plan.identity) === destination
          ? [destination]
          : [];
      }),
    );
    for (const child of await fsp.readdir(targetSkillsDir)) {
      if (!preservedDestinations.has(child)) {
        if ((await fsp.lstat(path.join(targetSkillsDir, child))).isDirectory()) {
          await ensureWritableSkillDirectories(targetSkillsDir, child);
        }
        await removePathWithinRoot({
          rootDir: targetDir,
          relativePath: path.join("skills", child),
          recursive: true,
          symlinks: "unlink",
        });
      }
    }

    const skillUsagePaths: SkillUsagePath[] = [];
    let copyFailed = false;
    for (const plan of plans) {
      const { destinationPath, entry } = plan;
      if (!destinationPath) {
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
            await ensureWritableSkillDirectories(targetSkillsDir, path.basename(destinationPath));
          }
        } catch (error) {
          if (entry.skill.source === "openclaw-library") {
            throw error;
          }
          copyFailed = true;
          const message = error instanceof Error ? error.message : JSON.stringify(error);
          skillsLogger.warn(`Failed to copy ${entry.skill.name} to sandbox: ${message}`);
          continue;
        }
      }
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
        sourceVersion,
        skillUsagePaths,
      });
      pruneMapToMaxSize(syncedSkillsUsageCache, 100);
    }
    return skillUsagePaths;
  });
}
