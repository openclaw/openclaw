import type { SkillSnapshot } from "../../agents/skills.js";
import { matchesSkillFilter } from "../../agents/skills/filter.js";
import { isSkillsSnapshotSchemaOutdated } from "../../agents/skills/snapshot-hydration.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";

const skillsSnapshotRuntimeLoader = createLazyImportLoader(
  () => import("./skills-snapshot.runtime.js"),
);

async function loadSkillsSnapshotRuntime() {
  return await skillsSnapshotRuntimeLoader.load();
}

export async function resolveCronSkillsSnapshot(params: {
  workspaceDir: string;
  config: OpenClawConfig;
  agentId: string;
  existingSnapshot?: SkillSnapshot;
  isFastTestEnv: boolean;
}): Promise<SkillSnapshot> {
  if (params.isFastTestEnv) {
    // Fast unit-test mode skips filesystem scans and snapshot refresh writes.
    return params.existingSnapshot ?? { prompt: "", skills: [] };
  }

  const runtime = await loadSkillsSnapshotRuntime();
  const snapshotVersion = runtime.getSkillsSnapshotVersion(params.workspaceDir);
  const skillFilter = runtime.resolveAgentSkillsFilter(params.config, params.agentId);
  const existingSnapshot = params.existingSnapshot;
  // Mirror the agent-command reuse predicate: legacy persisted snapshots may
  // lack `schemaVersion` (or carry a value below the current shape) and
  // therefore the lane-split fields. Force-refresh so Codex turns started
  // from a cron-driven snapshot see the new lanes instead of reusing a v1/v2
  // shape.
  const shouldRefresh =
    !existingSnapshot ||
    isSkillsSnapshotSchemaOutdated(existingSnapshot) ||
    existingSnapshot.version !== snapshotVersion ||
    !matchesSkillFilter(existingSnapshot.skillFilter, skillFilter);
  if (!shouldRefresh) {
    return existingSnapshot;
  }

  return runtime.buildWorkspaceSkillSnapshot(params.workspaceDir, {
    config: params.config,
    agentId: params.agentId,
    skillFilter,
    eligibility: {
      remote: runtime.getRemoteSkillEligibility({
        advertiseExecNode: runtime.canExecRequestNode({
          cfg: params.config,
          agentId: params.agentId,
        }),
      }),
    },
    snapshotVersion,
  });
}
