import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { SkillSnapshot } from "../types.js";

const skillsSnapshotRuntimeLoader = createLazyImportLoader(
  () => import("./cron-snapshot.runtime.js"),
);

export async function resolveCronSkillsSnapshot(params: {
  workspaceDir: string;
  config: OpenClawConfig;
  agentId: string;
  existingSnapshot?: SkillSnapshot;
  librarySelections?: SkillSnapshot["librarySelections"];
  isFastTestEnv: boolean;
}): Promise<SkillSnapshot> {
  if (params.isFastTestEnv) {
    // Fast unit-test mode skips filesystem scans and snapshot refresh writes.
    return params.existingSnapshot ?? { prompt: "", skills: [] };
  }

  const runtime = await skillsSnapshotRuntimeLoader.load();
  const skillFilter = runtime.resolveEffectiveAgentSkillFilter(params.config, params.agentId);
  const nodeSkills = runtime.resolveNodeExecEligibility({
    cfg: params.config,
    agentId: params.agentId,
  });
  return (
    await runtime.resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: params.workspaceDir,
      config: params.config,
      agentId: params.agentId,
      existingSnapshot: params.existingSnapshot,
      librarySelections: params.librarySelections,
      skillFilter,
      resolveEligibility: () => ({
        nodeSkills,
        remote: runtime.getRemoteSkillEligibility({
          advertiseExecNode: nodeSkills.canExec,
        }),
      }),
      watch: false,
      hydrateExisting: false,
    })
  ).snapshot;
}
