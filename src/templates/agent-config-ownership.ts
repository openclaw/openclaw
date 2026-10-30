import type { AgentConfig } from "../config/types.agents.js";
import { digestTemplateValue } from "./digest.js";

export function templateOwnedAgentConfig<T extends AgentConfig>(
  agent: T,
): Omit<T, "model" | "subagents"> {
  const { model: _model, subagents: _subagents, ...owned } = agent;
  return owned;
}

export function digestTemplateOwnedAgentConfig(agent: AgentConfig): string {
  return digestTemplateValue(templateOwnedAgentConfig(agent));
}

export function preserveOperatorAgentSettings(
  managedAgent: AgentConfig,
  currentAgent?: AgentConfig,
): AgentConfig {
  return {
    ...templateOwnedAgentConfig(managedAgent),
    ...(currentAgent && "model" in currentAgent ? { model: currentAgent.model } : {}),
    ...(currentAgent && "subagents" in currentAgent ? { subagents: currentAgent.subagents } : {}),
  };
}
