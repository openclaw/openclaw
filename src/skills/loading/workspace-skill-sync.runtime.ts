// Sandbox workspace skill synchronization is deferred behind the sandbox runtime boundary.
import fs from "node:fs";
import path from "node:path";
import { sha256File } from "@openclaw/fs-safe/durability";
import { root, type Root } from "@openclaw/fs-safe/root";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSandboxPath } from "../../agents/sandbox-paths.js";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { observeDiagnosticsTimelinePhases } from "../../infra/diagnostics-timeline.js";
import { hasErrnoCode } from "../../infra/errno.js";
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
// Windows chmod controls only the read-only attribute.
const GENERATED_IGNORE_MODE_MASK = process.platform === "win32" ? 0o200 : 0o7777;

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

async function removeSyncedSkillPath(
  target: Root,
  relativePath: string,
  assertCurrent?: () => void,
) {
  const stat = await fsp.lstat(path.join(target.rootDir, relativePath));
  assertCurrent?.();
  if (stat.isDirectory()) {
    await ensureWritableSkillDirectories(target, relativePath, assertCurrent);
  }
  await removePathWithinRoot({
    rootDir: target.rootDir,
    relativePath,
    recursive: true,
    symlinks: "unlink",
    assertBeforeMutation: assertCurrent,
  });
  assertCurrent?.();
}

// Recursive fs.cp does not expose custody checkpoints between its internal awaits and writes.
async function copySkillTree(
  source: string,
  destination: string,
  target: Root,
  reconcile: boolean,
  assertCurrent?: () => void,
): Promise<void> {
  if (!shouldSyncSkillPath(source)) {
    return;
  }
  const stat = await fsp.lstat(source);
  const relativePath = path.relative(target.rootDir, destination);
  let destinationStat: fs.Stats | undefined;
  if (reconcile) {
    try {
      destinationStat = await fsp.lstat(destination);
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  if (
    stat.isFile() &&
    destinationStat?.isFile() &&
    stat.size === destinationStat.size &&
    stat.mode === destinationStat.mode
  ) {
    // A same-size edit can share filesystem timestamps with the previous copy.
    const [sourceContent, destinationContent] = await Promise.all([
      sha256File(source, { maxBytes: stat.size }),
      sha256File(destination, { maxBytes: destinationStat.size }),
    ]);
    if (sourceContent.digest === destinationContent.digest) {
      return;
    }
  }
  if (destinationStat && !(stat.isDirectory() && destinationStat.isDirectory())) {
    await removeSyncedSkillPath(target, relativePath, assertCurrent);
    destinationStat = undefined;
  }
  if (stat.isDirectory()) {
    if (!destinationStat) {
      assertCurrent?.();
      await fsp.mkdir(destination, { mode: stat.mode | 0o700 });
    }
    await ensureWritableSkillDirectories(target, relativePath, assertCurrent, stat.mode);
    const children = await fsp.readdir(source);
    if (destinationStat) {
      const expected = new Set(
        children.filter((name) => shouldSyncSkillPath(path.join(source, name))),
      );
      const existing = await fsp.readdir(destination);
      for (const name of existing) {
        if (!expected.has(name)) {
          await removeSyncedSkillPath(target, path.join(relativePath, name), assertCurrent);
        }
      }
    }
    for (const name of children) {
      await copySkillTree(
        path.join(source, name),
        path.join(destination, name),
        target,
        reconcile,
        assertCurrent,
      );
    }
  } else if (stat.isSymbolicLink()) {
    const link = await fsp.readlink(source);
    const targetStat =
      process.platform === "win32" ? await fsp.stat(source).catch(() => undefined) : undefined;
    assertCurrent?.();
    await fsp.symlink(
      path.resolve(path.dirname(source), link),
      destination,
      targetStat?.isDirectory() ? "dir" : "file",
    );
  } else {
    // The pinned root revalidates custody after its awaits, at each mutation.
    await target.copyIn(`.${path.sep}${relativePath}`, source, {
      preserveSourceMode: true,
      sourceHardlinks: "allow",
      durable: false,
    });
  }
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
    const manifestPath = path.join(targetSkillsDir, SYNCED_SKILLS_MANIFEST_NAME);
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
    await ensureSyncedSkillsDirectory(targetSkillsDir, assertCurrent);
    assertCurrent?.();
    phases.mark("attempt.setup.sandbox.layout.skills_sync.root");
    const target = await root(targetSkillsDir, { assertBeforeMutation: assertCurrent });
    assertCurrent?.();
    phases.mark("attempt.setup.sandbox.layout.skills_sync.gitignore");
    const ignore = await target
      .read(".gitignore", { maxBytes: 2, symlinks: "reject" })
      .catch(() => undefined);
    if (
      ignore?.buffer.toString() !== "*\n" ||
      (ignore.stat.mode & GENERATED_IGNORE_MODE_MASK) !== (0o644 & GENERATED_IGNORE_MODE_MASK)
    ) {
      await target.write(".gitignore", "*\n", { mode: 0o644, durable: false });
    }
    assertCurrent?.();
    phases.mark("attempt.setup.sandbox.layout.skills_sync.manifest_read");
    const manifest = parseSyncedSkillsManifest(await tryReadJson<unknown>(manifestPath));
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
    await target.remove(SYNCED_SKILLS_MANIFEST_NAME, { force: true });
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
        await removeSyncedSkillPath(target, child, assertCurrent);
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
            for (const file of libraryFiles) {
              const filePath = path.join(destinationPath, file.path);
              assertCurrent?.();
              phases.mark("attempt.setup.sandbox.layout.skills_sync.library_directory");
              await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
              assertCurrent?.();
              phases.mark("attempt.setup.sandbox.layout.skills_sync.library_copy");
              await target.create(
                `.${path.sep}${path.relative(targetSkillsDir, filePath)}`,
                Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8"),
                { mode: file.executable ? 0o500 : 0o400, durable: false },
              );
            }
          } else {
            const syncSourceDir = entry.syncSourceDir ?? entry.skill.baseDir;
            phases.mark("attempt.setup.sandbox.layout.skills_sync.copy_tree");
            await copySkillTree(
              syncSourceDir,
              destinationPath,
              target,
              incrementalDestinations.has(path.basename(destinationPath)),
              assertCurrent,
            );
          }
        } catch (error) {
          assertCurrent?.();
          if (entry.skill.source === "openclaw-library") {
            throw error;
          }
          if (incrementalDestinations.has(path.basename(destinationPath))) {
            await removeSyncedSkillPath(target, path.basename(destinationPath), assertCurrent);
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
      await target.writeJson(SYNCED_SKILLS_MANIFEST_NAME, nextManifest, {
        trailingNewline: true,
        durable: false,
      });
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
