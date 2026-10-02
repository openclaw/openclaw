import type { AgentConfig } from "../config/types.agents.js";
import { digestClawValue } from "./digest.js";

export function clawOwnedAgentConfig<T extends AgentConfig>(
  agent: T,
): Omit<T, "model" | "subagents"> {
  const { model: _model, subagents: _subagents, ...owned } = agent;
  return owned;
}

export function digestClawOwnedAgentConfig(agent: AgentConfig): string {
  return digestClawValue(clawOwnedAgentConfig(agent));
}

export function matchesClawAgentConfigDigest(agent: AgentConfig, expectedDigest: string): boolean {
  return (
    digestClawOwnedAgentConfig(agent) === expectedDigest ||
    digestClawValue(agent) === expectedDigest
  );
}

export function preserveOperatorAgentSettings(
  managedAgent: AgentConfig,
  currentAgent?: AgentConfig,
): AgentConfig {
  return {
    ...clawOwnedAgentConfig(managedAgent),
    ...(currentAgent && "model" in currentAgent ? { model: currentAgent.model } : {}),
    ...(currentAgent && "subagents" in currentAgent ? { subagents: currentAgent.subagents } : {}),
  };
}
