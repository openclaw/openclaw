import { resolveAgentSkillsFilter } from "../../agents/agent-scope.js";
import { buildWorkspaceSkillSnapshot, type SkillSnapshot } from "../../agents/skills.js";
import { matchesSkillFilter } from "../../agents/skills/filter.js";
import {
  matchesSkillPolicySnapshot,
  resolveEffectiveSkillPolicy,
} from "../../agents/skills/policy.js";
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
  const skillPolicy = resolveEffectiveSkillPolicy(params.config, params.agentId);
  const existingSnapshot = params.existingSnapshot;
  const shouldRefresh =
    !existingSnapshot ||
    existingSnapshot.version !== snapshotVersion ||
    !matchesSkillFilter(existingSnapshot.skillFilter, skillFilter) ||
    !matchesSkillPolicySnapshot(
      existingSnapshot.policy,
      skillPolicy
        ? {
            agentId: skillPolicy.agentId,
            globalEnabled: skillPolicy.globalEnabled,
            agentEnabled: skillPolicy.agentEnabled,
            agentDisabled: skillPolicy.agentDisabled,
            effective: skillPolicy.effective,
          }
        : undefined,
    );
  if (!shouldRefresh) {
    return existingSnapshot;
  }

  return buildWorkspaceSkillSnapshot(params.workspaceDir, {
    config: params.config,
    agentId: params.agentId,
    skillFilter,
    eligibility: { remote: getRemoteSkillEligibility() },
    snapshotVersion,
  });
}
