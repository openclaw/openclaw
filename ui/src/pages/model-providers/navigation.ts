import type { ApplicationContext } from "../../app/context.ts";

export function navigateToModelProvider(
  context: Pick<ApplicationContext, "navigate" | "settingsAgentSelection"> | undefined,
  agentId: string | null,
  provider: string,
) {
  // Settings owns a separate agent selection; preserve the composer's source agent.
  context?.settingsAgentSelection.set(agentId);
  context?.navigate("model-providers", { search: `?provider=${encodeURIComponent(provider)}` });
}
