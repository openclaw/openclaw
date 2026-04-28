import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope.js";

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveSystemPromptOverride(params: {
  config?: OpenClawConfig;
  agentId?: string;
}): string | undefined {
  const config = params.config;
  if (!config) {
    return undefined;
  }
  const agentOverride = trimNonEmpty(
    params.agentId ? resolveAgentConfig(config, params.agentId)?.systemPromptOverride : undefined,
  );
  if (agentOverride) {
    return agentOverride;
  }
  return trimNonEmpty(config.agents?.defaults?.systemPromptOverride);
}

/**
 * Combine an agent-level `systemPromptOverride` with a per-run
 * `extraSystemPrompt`. Subagent spawns set `extraSystemPrompt` to the
 * task-bearing `## Your Role` block — see `subagent-spawn.ts:1073` and
 * `buildSubagentSystemPrompt`. Without this combination, agents configured
 * with a `systemPromptOverride` would silently drop the delegated task and
 * the spawned child would only receive its bootstrap user message
 * ("Begin. Your assigned task is in the system prompt under Your Role…")
 * with no `## Your Role` to read. See #73624.
 *
 * Returns `undefined` when no override is present so callers can fall back
 * to `buildEmbeddedSystemPrompt` / `buildSystemPrompt`, which already
 * incorporate `extraSystemPrompt` into the standard prompt body.
 */
export function combineSystemPromptOverrideWithExtra(params: {
  override: string | undefined;
  extraSystemPrompt?: string;
}): string | undefined {
  const override = trimNonEmpty(params.override);
  if (!override) {
    return undefined;
  }
  const extra = trimNonEmpty(params.extraSystemPrompt);
  if (!extra) {
    return override;
  }
  return `${override}\n\n${extra}`;
}
