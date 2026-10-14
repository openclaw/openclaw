// Sandbox workspace skill synchronization is deferred behind the sandbox runtime boundary.
import fs from "node:fs";
import path from "node:path";
import { root, type Root } from "@openclaw/fs-safe/root";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSandboxPath } from "../../agents/sandbox-paths.js";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { tryReadJson } from "../../infra/json-files.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { retainMutationAuthority } from "../../infra/mutation-authority.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import {
  prepareSkillLibrarySelection,
  readSelectedSkillLibraryFiles,
} from "../library/selection.js";
import { getSkillsSnapshotVersion, getSkillsResourceVersion } from "../runtime/refresh-state.js";
import { resolveSkillSnapshotExecutionFileHost } from "../runtime/skill-snapshot-provenance.js";
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

async function ensureSyncedSkillsDirectory(
  targetSkillsDir: string,
  assertCurrent?: () => void,
): Promise<void> {
  try {
    const stat = await fsp.lstat(targetSkillsDir);
    assertCurrent?.();
    if (stat.isDirectory()) {
      return;
    }
    await removePathWithinRoot({
      rootDir: path.dirname(targetSkillsDir),
      relativePath: path.basename(targetSkillsDir),
      recursive: true,
      symlinks: "unlink",
      assertBeforeMutation: assertCurrent,
    });
  } catch (error) {
    assertCurrent?.();
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  assertCurrent?.();
  await fsp.mkdir(targetSkillsDir, { recursive: true });
}

// Recursive fs.cp does not expose custody checkpoints between its internal awaits and writes.
async function copySkillTree(
  source: string,
  destination: string,
  target: Root,
  assertCurrent?: () => void,
): Promise<void> {
  if (!shouldSyncSkillPath(source)) {
    return;
  }
  const stat = await fsp.lstat(source);
  assertCurrent?.();
  if (stat.isDirectory()) {
    await fsp.mkdir(destination, { mode: stat.mode | 0o700 });
    assertCurrent?.();
    await ensureWritableSkillDirectories(
      target.rootDir,
      path.relative(target.rootDir, destination),
      assertCurrent,
      stat.mode,
    );
    const children = await fsp.readdir(source);
    assertCurrent?.();
    for (const name of children) {
      await copySkillTree(
        path.join(source, name),
        path.join(destination, name),
        target,
        assertCurrent,
      );
    }
  } else if (stat.isSymbolicLink()) {
    const link = await fsp.readlink(source);
    assertCurrent?.();
    const targetStat =
      process.platform === "win32" ? await fsp.stat(source).catch(() => undefined) : undefined;
    assertCurrent?.();
    await fsp.symlink(
      path.resolve(path.dirname(source), link),
      destination,
      targetStat?.isDirectory() ? "dir" : "file",
    );
  } else {
    await target.copyIn(`.${path.sep}${path.relative(target.rootDir, destination)}`, source, {
      preserveSourceMode: true,
      sourceHardlinks: "allow",
      durable: false,
    });
  }
  assertCurrent?.();
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
  assertCurrent?: () => void;
}): Promise<SkillUsagePath[]> {
  const assertCurrent = params.assertCurrent
    ? retainMutationAuthority(params.assertCurrent)
    : undefined;
  assertCurrent?.();
  const sourceDir = resolveUserPath(params.sourceWorkspaceDir);
  const targetDir = resolveUserPath(params.targetWorkspaceDir);
  if (sourceDir === targetDir) {
    return [];
  }

  const synced = await skillsSyncQueue.enqueue(`syncSkills:${targetDir}`, async () => {
    assertCurrent?.();
    const targetSkillsDir = path.join(targetDir, "skills");
    const manifestPath = path.join(targetSkillsDir, SYNCED_SKILLS_MANIFEST_NAME);
    const skillsSnapshot = params.skillsSnapshot;
    const skillRoots = skillsSnapshot?.skillRoots;
    const executionWorkspaceFileHost = resolveSkillSnapshotExecutionFileHost(skillsSnapshot);
    const sourceWorkspace = skillRoots?.agentWorkspaceDir ?? sourceDir;
    const sourceScope = {
      executionWorkspaceDir: skillRoots?.executionWorkspaceDir,
      executionWorkspaceFileHost,
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
        executionWorkspaceFileHost,
        skillsSnapshot?.librarySelections,
      ]),
    );
    await ensureSyncedSkillsDirectory(targetSkillsDir, assertCurrent);
    assertCurrent?.();
    const target = await root(targetSkillsDir, { assertBeforeMutation: assertCurrent });
    assertCurrent?.();
    const manifest = parseSyncedSkillsManifest(await tryReadJson<unknown>(manifestPath));
    assertCurrent?.();
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
        executionWorkspaceFileHost,
      });
      assertCurrent?.();
      if (
        getSkillsSnapshotVersion(sourceWorkspace) === skillsVersion &&
        getSkillsResourceVersion(sourceWorkspace, sourceScope) === sourceVersion
      ) {
        break;
      }
    }
    if (skillsSnapshot?.librarySelections?.length) {
      const selectedNames = new Set(skillsSnapshot.skills.map((skill) => skill.name));
      const selectedEntries = await prepareSkillLibrarySelection(
        skillsSnapshot.librarySelections,
        {},
        assertCurrent ?? (() => {}),
      );
      assertCurrent?.();
      entries.push(...selectedEntries.filter((entry) => selectedNames.has(entry.skill.name)));
    }

    const usedDirNames = new Set<string>();
    const plans: Array<{ destinationPath?: string; entry: SkillEntry; identity: string }> = [];
    for (const entry of entries) {
      const identity = resolveSyncedSkillIdentity(resolveSkillKey(entry), entry.skill.name);
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

    assertCurrent?.();
    await target.remove(SYNCED_SKILLS_MANIFEST_NAME, { force: true });
    assertCurrent?.();
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
    const children = await fsp.readdir(targetSkillsDir);
    assertCurrent?.();
    for (const child of children) {
      if (!preservedDestinations.has(child)) {
        const stat = await fsp.lstat(path.join(targetSkillsDir, child));
        assertCurrent?.();
        if (stat.isDirectory()) {
          await ensureWritableSkillDirectories(targetSkillsDir, child, assertCurrent);
        }
        await removePathWithinRoot({
          rootDir: targetDir,
          relativePath: path.join("skills", child),
          recursive: true,
          symlinks: "unlink",
          assertBeforeMutation: assertCurrent,
        });
        assertCurrent?.();
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
            assertCurrent?.();
            for (const file of files) {
              const filePath = path.join(destinationPath, file.path);
              assertCurrent?.();
              await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
              assertCurrent?.();
              await target.create(
                `.${path.sep}${path.relative(targetSkillsDir, filePath)}`,
                Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8"),
                { mode: file.executable ? 0o500 : 0o400, durable: false },
              );
            }
          } else {
            const syncSourceDir = entry.syncSourceDir ?? entry.skill.baseDir;
            await copySkillTree(syncSourceDir, destinationPath, target, assertCurrent);
          }
        } catch (error) {
          assertCurrent?.();
          if (entry.skill.source === "openclaw-library") {
            throw error;
          }
          copyFailed = true;
          const message = error instanceof Error ? error.message : JSON.stringify(error);
          skillsLogger.warn(`Failed to copy ${entry.skill.name} to sandbox: ${message}`);
          continue;
        }
      }
      assertCurrent?.();
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
      assertCurrent?.();
      await target.writeJson(SYNCED_SKILLS_MANIFEST_NAME, nextManifest, { trailingNewline: true });
      assertCurrent?.();
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
  assertCurrent?.();
  return synced;
}
