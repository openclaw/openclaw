// Sandbox workspace skill synchronization is deferred behind the sandbox runtime boundary.
import fsp from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSandboxPath } from "../../agents/sandbox-paths.js";
import type { SandboxStateOwnerPath } from "../../agents/sandbox/state-owner-path.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { observeDiagnosticsTimelinePhases } from "../../infra/diagnostics-timeline.js";
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
import { syncSkillsFilesystem } from "../runtime/refresh.js";
import { resolveSkillSnapshotExecutionFileHost } from "../runtime/skill-snapshot-provenance.js";
import { fingerprintSkillSnapshotConfig } from "../runtime/snapshot-config-fingerprint.js";
import type {
  SkillEligibilityContext,
  SkillEntry,
  SkillSnapshot,
  SkillUsagePath,
} from "../types.js";
import { resolveSkillKey } from "./frontmatter.js";
import { resolveSkillTelemetrySource } from "./source.js";
import { prepareWorkspaceSkills } from "./workspace-skill-loader.js";

const skillsLogger = createSubsystemLogger("skills");
const skillsSyncQueue = new KeyedAsyncQueue();

type SyncedSkillsManifest = {
  destinations: Record<string, unknown>;
  skillRootsFingerprint: string;
  skillsVersion: number;
  sourceVersion: number;
};

const syncedSkillsUsageCache = new Map<
  string,
  {
    manifest: SyncedSkillsManifest;
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
    typeof value.sourceVersion !== "number" ||
    !Number.isFinite(value.sourceVersion) ||
    typeof value.skillRootsFingerprint !== "string" ||
    !isRecord(value.destinations)
  ) {
    return null;
  }
  return {
    destinations: value.destinations,
    skillRootsFingerprint: value.skillRootsFingerprint,
    skillsVersion: value.skillsVersion,
    sourceVersion: value.sourceVersion,
  };
}

function resolveSyncedSkillsManifestKey(
  manifest: Omit<SyncedSkillsManifest, "destinations">,
  entryKeys: string[],
): string {
  return JSON.stringify([
    manifest.skillsVersion,
    manifest.skillRootsFingerprint,
    entryKeys,
    manifest.sourceVersion,
  ]);
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
  readOnlyTarget?: boolean;
  assertCurrent?: () => void;
  stateOwnerPath?: SandboxStateOwnerPath;
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

  using phases = observeDiagnosticsTimelinePhases(
    "attempt.setup.sandbox.layout.skills_sync.queue_wait",
  );
  const synced = await skillsSyncQueue.enqueue(`syncSkills:${targetDir}`, async () => {
    phases.mark("attempt.setup.sandbox.layout.skills_sync.identity");
    assertCurrent?.();
    const targetSkillsDir = path.join(targetDir, "skills");
    const skillsSnapshot = params.skillsSnapshot;
    const skillRoots = skillsSnapshot?.skillRoots;
    const executionWorkspaceFileHost = resolveSkillSnapshotExecutionFileHost(skillsSnapshot);
    const sourceWorkspace = skillRoots?.agentWorkspaceDir ?? sourceDir;
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
    phases.mark("attempt.setup.sandbox.layout.skills_sync.directory");
    const filesystem = (operation: Parameters<typeof syncSkillsFilesystem>[0]) =>
      syncSkillsFilesystem(
        operation,
        assertCurrent,
        (phase) => phases.mark(`attempt.setup.sandbox.layout.skills_sync.${phase}`),
        params.stateOwnerPath,
      );
    const prepared = await filesystem({ operation: "prepare", directory: targetSkillsDir });
    if (!prepared) {
      throw new Error("Skills filesystem preparation returned no target");
    }
    const target = prepared.target;
    const manifest = parseSyncedSkillsManifest(prepared.manifest);
    assertCurrent?.();
    phases.mark("attempt.setup.sandbox.layout.skills_sync.reuse");
    const expectedManifestKey =
      skillsSnapshot?.version === getSkillsSnapshotVersion(sourceWorkspace)
        ? resolveSyncedSkillsManifestKey(
            {
              skillRootsFingerprint,
              skillsVersion: skillsSnapshot.version,
              sourceVersion: getSkillsResourceVersion(sourceWorkspace),
            },
            skillsSnapshot.skills
              .map((skill) => resolveSyncedSkillIdentity(skill.skillKey ?? skill.name, skill.name))
              .toSorted(),
          )
        : undefined;
    const cachedUsage = syncedSkillsUsageCache.get(targetSkillsDir);
    const manifestKey = manifest
      ? resolveSyncedSkillsManifestKey(manifest, Object.keys(manifest.destinations).toSorted())
      : undefined;
    if (
      expectedManifestKey &&
      manifestKey === expectedManifestKey &&
      cachedUsage?.manifestKey === manifestKey
    ) {
      return cachedUsage.skillUsagePaths;
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
    phases.mark("attempt.setup.sandbox.layout.skills_sync.discovery");
    const entries = await prepareWorkspaceSkills(sourceWorkspace, {
      ...loadOptions,
      executionWorkspaceDir: skillRoots?.executionWorkspaceDir,
      executionWorkspaceFileHost,
    });
    assertCurrent?.();
    const sourceVersion = getSkillsResourceVersion(sourceWorkspace);
    const skillsVersion = getSkillsSnapshotVersion(sourceWorkspace);
    if (skillsSnapshot?.librarySelections?.length) {
      const selectedNames = new Set(skillsSnapshot.skills.map((skill) => skill.name));
      phases.mark("attempt.setup.sandbox.layout.skills_sync.library_selection");
      const selectedEntries = await prepareSkillLibrarySelection(
        skillsSnapshot.librarySelections,
        {},
        assertCurrent ?? (() => {}),
      );
      assertCurrent?.();
      entries.push(...selectedEntries.filter((entry) => selectedNames.has(entry.skill.name)));
    }

    phases.mark("attempt.setup.sandbox.layout.skills_sync.plan");
    const usedDirNames = new Set<string>();
    const plans: Array<{
      destinationPath?: string;
      entry: SkillEntry;
      identity: string;
      pin?: NonNullable<SkillSnapshot["librarySelections"]>[number];
    }> = [];
    for (const entry of entries) {
      const identity = resolveSyncedSkillIdentity(resolveSkillKey(entry), entry.skill.name);
      const pin = skillsSnapshot?.librarySelections?.find(
        (selection) => selection.name === entry.skill.name,
      );
      if (entry.skill.filePath.startsWith("node://")) {
        plans.push({ entry, identity, pin });
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
      plans.push({ destinationPath, entry, identity, pin });
    }

    assertCurrent?.();
    phases.mark("attempt.setup.sandbox.layout.skills_sync.manifest_remove");
    await filesystem({ operation: "remove-manifest", target });
    assertCurrent?.();
    // Remote mirrors may return guest-written manifests; only protected mounts can reuse them.
    const previousManifest =
      cachedUsage && cachedUsage.manifestKey === manifestKey
        ? cachedUsage.manifest
        : params.readOnlyTarget
          ? manifest
          : undefined;
    syncedSkillsUsageCache.delete(targetSkillsDir);
    const preservedDestinations = new Set(
      plans.flatMap((plan) => {
        const destination = plan.destinationPath ? path.basename(plan.destinationPath) : null;
        return destination &&
          previousManifest?.skillRootsFingerprint === skillRootsFingerprint &&
          previousManifest.destinations[plan.identity] === destination &&
          previousManifest.skillsVersion === skillsVersion &&
          previousManifest.sourceVersion === sourceVersion
          ? [destination]
          : [];
      }),
    );
    phases.mark("attempt.setup.sandbox.layout.skills_sync.target_scan");
    const children = new Set(await fsp.readdir(targetSkillsDir));
    assertCurrent?.();
    // A restart loses usage records, not copied bytes. Reconcile existing trees
    // against current content before reuse, independently of the process version.
    const incrementalDestinations = new Set(
      plans.flatMap((plan) => {
        const destination = plan.destinationPath ? path.basename(plan.destinationPath) : null;
        return destination && children.has(destination) && !plan.pin ? [destination] : [];
      }),
    );
    phases.mark("attempt.setup.sandbox.layout.skills_sync.remove_stale");
    for (const child of children) {
      if (
        child !== ".gitignore" &&
        !preservedDestinations.has(child) &&
        !incrementalDestinations.has(child)
      ) {
        await filesystem({ operation: "remove", target, relativePath: child });
      }
    }

    const skillUsagePaths: SkillUsagePath[] = [];
    let copyFailed = false;
    for (const plan of plans) {
      const { destinationPath, entry, pin } = plan;
      if (!destinationPath) {
        continue;
      }
      if (!preservedDestinations.has(path.basename(destinationPath))) {
        try {
          if (pin) {
            phases.mark("attempt.setup.sandbox.layout.skills_sync.library_read");
            const libraryFiles = await readSelectedSkillLibraryFiles(pin);
            assertCurrent?.();
            await filesystem({
              operation: "library",
              target,
              destination: destinationPath,
              files: libraryFiles,
            });
          } else {
            const syncSourceDir = entry.syncSourceDir ?? entry.skill.baseDir;
            phases.mark("attempt.setup.sandbox.layout.skills_sync.copy_tree");
            await filesystem({
              operation: "copy",
              target,
              source: syncSourceDir,
              destination: destinationPath,
              reconcile: incrementalDestinations.has(path.basename(destinationPath)),
            });
          }
        } catch (error) {
          assertCurrent?.();
          if (entry.skill.source === "openclaw-library") {
            throw error;
          }
          if (incrementalDestinations.has(path.basename(destinationPath))) {
            await filesystem({
              operation: "remove",
              target,
              relativePath: path.basename(destinationPath),
            });
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
        sourceFilePath: entry.skill.filePath,
        skillFile: await fsp.realpath(entry.skill.filePath).catch(() => entry.skill.filePath),
        skillName: entry.skill.name,
        skillSource: resolveSkillTelemetrySource(entry.skill),
      });
    }
    if (!copyFailed) {
      const nextManifest: SyncedSkillsManifest = {
        destinations: Object.fromEntries(
          plans.map((plan) => [
            plan.identity,
            plan.destinationPath ? path.basename(plan.destinationPath) : null,
          ]),
        ),
        skillRootsFingerprint,
        skillsVersion,
        sourceVersion,
      };
      assertCurrent?.();
      phases.mark("attempt.setup.sandbox.layout.skills_sync.manifest_write");
      await filesystem({ operation: "manifest", target, manifest: nextManifest });
      assertCurrent?.();
      syncedSkillsUsageCache.set(targetSkillsDir, {
        manifest: nextManifest,
        manifestKey: resolveSyncedSkillsManifestKey(
          nextManifest,
          plans.map((plan) => plan.identity).toSorted(),
        ),
        skillUsagePaths,
      });
      pruneMapToMaxSize(syncedSkillsUsageCache, 100);
    }
    return skillUsagePaths;
  });
  assertCurrent?.();
  return synced;
}
