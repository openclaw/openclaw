import { stableStringify } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { matchesSkillFilter } from "../discovery/filter.js";
import { buildSkillSnapshot } from "../loading/workspace-skill-prompt.js";
import { normalizeWorkspaceSkillRoots } from "../loading/workspace-skill-roots.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION } from "../types.js";
import type { SkillEligibilityContext, SkillSnapshot } from "../types.js";
import { getSkillsSnapshotVersion, shouldRefreshSnapshotForVersion } from "./refresh-state.js";
import { ensureSkillsWatcher } from "./refresh.js";
import { fingerprintSkillSnapshotConfig } from "./snapshot-config-fingerprint.js";

// Full snapshots let fresh sessions and runtime-only hydration share one versioned rebuild.
const skillSnapshotCache = new Map<string, SkillSnapshot>();
const pendingSkillSnapshots = new Map<
  string,
  {
    promise: Promise<SkillSnapshot | undefined>;
    waiters: Set<() => void>;
  }
>();
const SKILL_SNAPSHOT_CACHE_MAX = 10;

/** Inputs that make a resolved skill snapshot reusable within a process. */
type ReusableSkillSnapshotParams = {
  librarySelections?: SkillSnapshot["librarySelections"];
  workspaceDir: string;
  executionWorkspaceDir?: string;
  config: OpenClawConfig;
  agentId?: string;
  skillFilter?: string[];
  skillOverrides?: Record<string, boolean>;
  eligibility?: SkillEligibilityContext;
  resolveEligibility?: () => SkillEligibilityContext | undefined;
  assertCurrent?: () => void;
  existingSnapshot?: SkillSnapshot;
  snapshotVersion?: number;
  watch?: boolean;
  hydrateExisting?: boolean;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

type ReusableSkillSnapshotResult = {
  snapshot: SkillSnapshot;
  shouldRefresh: boolean;
  snapshotVersion: number;
};

function cacheSkillSnapshot(cacheKey: string, snapshot: SkillSnapshot): SkillSnapshot {
  skillSnapshotCache.set(cacheKey, snapshot);
  pruneMapToMaxSize(skillSnapshotCache, SKILL_SNAPSHOT_CACHE_MAX);
  return snapshot;
}

export async function resolveReusableWorkspaceSkillSnapshot(
  params: ReusableSkillSnapshotParams,
): Promise<ReusableSkillSnapshotResult> {
  params.assertCurrent?.();
  const eligibility = params.resolveEligibility?.() ?? params.eligibility;
  const normalizedRoots = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: params.workspaceDir,
    executionWorkspaceDir: params.executionWorkspaceDir,
  });
  const skillRoots = normalizedRoots.executionWorkspaceDir
    ? {
        agentWorkspaceDir: normalizedRoots.agentWorkspaceDir,
        executionWorkspaceDir: normalizedRoots.executionWorkspaceDir,
      }
    : undefined;
  const watcherWorkspaceDir = skillRoots?.agentWorkspaceDir ?? params.workspaceDir;
  if (params.watch !== false) {
    ensureSkillsWatcher({
      workspaceDir: watcherWorkspaceDir,
      ...(skillRoots ? { executionWorkspaceDir: skillRoots.executionWorkspaceDir } : {}),
      config: params.config,
      agentId: params.agentId,
      ...(params.pluginMetadataSnapshot
        ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
        : {}),
    });
  }
  const snapshotVersion = params.snapshotVersion ?? getSkillsSnapshotVersion(watcherWorkspaceDir);
  const promptFormatChanged =
    params.existingSnapshot?.promptFormatVersion !== WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION;
  const skillVersionChanged = shouldRefreshSnapshotForVersion(
    params.existingSnapshot?.version,
    snapshotVersion,
  );
  const nodeSkillsEligibilityChanged =
    stableStringify(params.existingSnapshot?.nodeSkillsEligibility) !==
    stableStringify(eligibility?.nodeSkills);
  const skillOverridesChanged =
    stableStringify(params.existingSnapshot?.skillOverrides) !==
    stableStringify(params.skillOverrides);
  const skillRootsChanged =
    stableStringify(params.existingSnapshot?.skillRoots) !== stableStringify(skillRoots);
  const librarySelections = params.librarySelections ?? params.existingSnapshot?.librarySelections;
  const libraryChanged =
    stableStringify(librarySelections) !==
    stableStringify(params.existingSnapshot?.librarySelections);
  const shouldRefresh =
    libraryChanged ||
    promptFormatChanged ||
    skillVersionChanged ||
    nodeSkillsEligibilityChanged ||
    skillRootsChanged ||
    !matchesSkillFilter(params.existingSnapshot?.skillFilter, params.skillFilter) ||
    skillOverridesChanged;
  if (
    params.existingSnapshot &&
    !shouldRefresh &&
    (params.hydrateExisting === false || params.existingSnapshot.resolvedSkills !== undefined)
  ) {
    return { snapshot: params.existingSnapshot, shouldRefresh, snapshotVersion };
  }
  const sourceVersion = getSkillsSnapshotVersion(watcherWorkspaceDir);
  const eligibilityKey = stableStringify(eligibility);
  const projectionIsCurrent = () =>
    getSkillsSnapshotVersion(watcherWorkspaceDir) === sourceVersion &&
    stableStringify(params.resolveEligibility?.() ?? params.eligibility) === eligibilityKey;
  const buildSnapshot = async (assertCurrent: () => void) => {
    const snapshot = await buildSkillSnapshot(normalizedRoots.agentWorkspaceDir, {
      executionWorkspaceDir: normalizedRoots.executionWorkspaceDir,
      librarySelections,
      config: params.config,
      preserveEntryOrder: Boolean(skillRoots),
      agentId: params.agentId,
      skillFilter: params.skillFilter,
      skillOverrides: params.skillOverrides,
      eligibility,
      assertCurrent,
      pluginMetadataSnapshot: params.pluginMetadataSnapshot,
      snapshotVersion,
    });
    return {
      ...snapshot,
      ...(skillRoots ? { skillRoots } : {}),
      ...(librarySelections ? { librarySelections } : {}),
    };
  };

  const buildSnapshotCacheKey = () =>
    JSON.stringify([
      params.workspaceDir,
      librarySelections,
      skillRoots,
      snapshotVersion,
      params.skillFilter,
      params.skillOverrides,
      params.agentId,
      eligibility,
      fingerprintSkillSnapshotConfig(params.config),
    ]);

  const cachedRebuild = async (snapshotCacheKey = buildSnapshotCacheKey()) => {
    const cachedSnapshot = skillSnapshotCache.get(snapshotCacheKey);
    if (cachedSnapshot) {
      return cachedSnapshot;
    }
    const assertCurrent = () => params.assertCurrent?.();
    let pending = pendingSkillSnapshots.get(snapshotCacheKey);
    if (!pending) {
      const waiters = new Set([assertCurrent]);
      const assertLiveWaiter = () => {
        let failure: unknown;
        for (const waiter of waiters) {
          try {
            waiter();
          } catch (error) {
            waiters.delete(waiter);
            failure = error;
          }
        }
        if (waiters.size === 0) {
          throw failure;
        }
      };
      const promise = buildSnapshot(assertLiveWaiter).then((snapshot) => {
        assertLiveWaiter();
        if (!projectionIsCurrent()) {
          return undefined;
        }
        return cacheSkillSnapshot(snapshotCacheKey, snapshot);
      });
      pending = { promise, waiters };
      pendingSkillSnapshots.set(snapshotCacheKey, pending);
    } else if (pending.waiters.size > 0) {
      pending.waiters.add(assertCurrent);
    }
    try {
      const snapshot = await pending.promise;
      assertCurrent();
      return snapshot;
    } catch (error) {
      assertCurrent();
      // An abandoned build must drain before a new live caller starts its replacement.
      if (pending.waiters.size === 0) {
        return undefined;
      }
      throw error;
    } finally {
      pending.waiters.delete(assertCurrent);
      if (pendingSkillSnapshots.get(snapshotCacheKey) === pending) {
        pendingSkillSnapshots.delete(snapshotCacheKey);
      }
    }
  };

  const snapshot =
    !params.existingSnapshot || shouldRefresh
      ? await cachedRebuild()
      : await cachedRebuild().then(
          (rebuilt) =>
            rebuilt && {
              ...params.existingSnapshot!,
              resolvedSkills: rebuilt.resolvedSkills,
            },
        );
  if (!snapshot || !projectionIsCurrent()) {
    const currentVersion = getSkillsSnapshotVersion(watcherWorkspaceDir);
    return resolveReusableWorkspaceSkillSnapshot({
      ...params,
      // Capacity fallback invalidates on reconciliation; retry only the prepared source work.
      watch: false,
      // An explicit version describes the original request, never a later rebuilt source tree.
      ...(currentVersion !== sourceVersion ? { snapshotVersion: currentVersion } : {}),
    });
  }
  params.assertCurrent?.();
  return { snapshot, shouldRefresh, snapshotVersion };
}
