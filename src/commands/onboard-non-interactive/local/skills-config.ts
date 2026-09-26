import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { isNodeManagerChoice, type OnboardOptions } from "../../onboard-types.js";

/** Applies the non-interactive skills install options to the pending config. */
export function applyNonInteractiveSkillsConfig(params: {
  nextConfig: OpenClawConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
}) {
  const { nextConfig, opts, runtime } = params;
  if (opts.skipSkills) {
    // Preserve existing skill install config when the operator opted out of the
    // skills setup phase for this non-interactive run.
    return nextConfig;
  }

  const nodeManager = opts.nodeManager;
  if (nodeManager !== undefined && !isNodeManagerChoice(nodeManager)) {
    runtime.error('Invalid --node-manager. Use "npm", "pnpm", or "bun".');
    runtime.exit(1);
    return nextConfig;
  }
  return {
    ...nextConfig,
    skills: {
      ...nextConfig.skills,
      install: {
        ...nextConfig.skills?.install,
        nodeManager: nodeManager ?? nextConfig.skills?.install?.nodeManager ?? "npm",
      },
    },
  };
}
