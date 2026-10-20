import { listAgentIds, tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { configurePrompts } from "./configure.prompts.js";
import type { ModelWriteTarget, OnboardingAgentTarget } from "./onboard-agent-target.js";

export type ConfigureModelWrite = {
  target: OnboardingAgentTarget;
  modelWriteTarget?: ModelWriteTarget;
};

/** Let an explicit fleet opt into shared model defaults; one agent stays the default owner. */
export async function resolveConfigureModelWrite(params: {
  config: OpenClawConfig;
  setupAgentId?: string;
  resolveSetupTarget: (agentId?: string) => Promise<OnboardingAgentTarget>;
}): Promise<ConfigureModelWrite> {
  const agentIds = listAgentIds(params.config);
  const explicitFleet = params.config.agents?.ownership === "explicit" && agentIds.length > 1;
  if (!explicitFleet) {
    return { target: await params.resolveSetupTarget() };
  }

  const scope = await configurePrompts.select<ModelWriteTarget>({
    message: "Where should this model setup apply?",
    initialValue: "agent",
    options: [
      {
        value: "defaults",
        label: "Shared defaults",
        hint: "Primary, catalog, and allowlist on agents.defaults. Agents with their own model settings keep them.",
      },
      {
        value: "agent",
        label: "One agent",
        hint: "Primary, runtime, and allowlist for the agent you choose.",
      },
    ],
  });
  if (scope === "defaults") {
    // Credentials and catalog discovery still need one owner; reuse configure's setup agent.
    return { target: await params.resolveSetupTarget(), modelWriteTarget: "defaults" };
  }

  const systemAgentId = tryResolveAmbientOwnerAgentId(params.config);
  const initialAgentId = params.setupAgentId ?? systemAgentId;
  const agentId = await configurePrompts.select({
    message: "Which agent should receive this model policy?",
    ...(initialAgentId ? { initialValue: initialAgentId } : {}),
    options: agentIds.map((id) => ({
      value: id,
      label: id === systemAgentId ? `${id} (system agent)` : id,
    })),
  });
  return { target: await params.resolveSetupTarget(agentId), modelWriteTarget: "agent" };
}
