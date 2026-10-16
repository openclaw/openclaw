import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { OnboardOptions } from "../../onboard-types.js";

export function applyNonInteractiveSkillsConfig(params: {
  nextConfig: OpenClawConfig;
  opts: OnboardOptions;
}) {
  const { nextConfig, opts } = params;
  if (opts.skipSkills) {
    // Preserve existing skill install config when the operator opted out of the
    // skills setup phase for this non-interactive run.
    return nextConfig;
  }

  return {
    ...nextConfig,
    skills: {
      ...nextConfig.skills,
      install: {
        ...nextConfig.skills?.install,
        nodeManager: opts.nodeManager ?? nextConfig.skills?.install?.nodeManager ?? "npm",
      },
    },
  };
}
