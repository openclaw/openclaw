import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { SkillSnapshot } from "../../skills/types.js";

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
  const skillFilter = runtime.resolveEffectiveAgentSkillFilter(params.config, params.agentId);
  return runtime.resolveReusableWorkspaceSkillSnapshot({
    workspaceDir: params.workspaceDir,
    config: params.config,
    agentId: params.agentId,
    existingSnapshot: params.existingSnapshot,
    skillFilter,
    eligibility: {
      remote: runtime.getRemoteSkillEligibility({
        advertiseExecNode: runtime.canExecRequestNode({
          cfg: params.config,
          agentId: params.agentId,
        }),
      }),
    },
    watch: false,
    hydrateExisting: false,
  }).snapshot;
}
