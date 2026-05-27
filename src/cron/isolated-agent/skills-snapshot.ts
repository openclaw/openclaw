import { resolveAgentSkillsFilter } from "../../agents/agent-scope.js";
import { buildWorkspaceSkillSnapshot, type SkillSnapshot } from "../../agents/skills.js";
import { matchesSkillFilter } from "../../agents/skills/filter.js";
import { getSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import type { OpenClawConfig } from "../../config/config.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";

export function resolveCronSkillsSnapshot(params: {
  workspaceDir: string;
  config: OpenClawConfig;
  agentId: string;
  existingSnapshot?: SkillSnapshot;
  isFastTestEnv: boolean;
}): SkillSnapshot {
  if (params.isFastTestEnv) {
    // Fast unit-test mode skips filesystem scans and snapshot refresh writes.
    return params.existingSnapshot ?? { prompt: "", skills: [] };
  }

  const snapshotVersion = getSkillsSnapshotVersion(params.workspaceDir);
  const skillFilter = resolveAgentSkillsFilter(params.config, params.agentId);
  const existingSnapshot = params.existingSnapshot;
  const shouldRefresh =
    !existingSnapshot ||
    existingSnapshot.version !== snapshotVersion ||
    !matchesSkillFilter(existingSnapshot.skillFilter, skillFilter);
  if (!shouldRefresh) {
    return existingSnapshot;
  }

  return buildWorkspaceSkillSnapshot(params.workspaceDir, {
    config: params.config,
    skillFilter,
    eligibility: { remote: getRemoteSkillEligibility() },
    snapshotVersion,
  });
}
