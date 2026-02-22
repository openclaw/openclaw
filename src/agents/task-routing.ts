/**
 * Task-based model routing: select a model from config rules based on prompt keywords
 * and/or allowed tools. Used when agents.defaults.model.routing.enabled is true.
 */

import type { OpenClawConfig } from "../config/config.js";
import type { AgentModelRoutingConfig } from "../config/types.agent-defaults.js";
import { parseModelRef } from "./model-selection.js";

export type TaskRoutedModelRef = { provider: string; model: string };

/**
 * Resolves the model to use for this run when task-based routing is enabled.
 * Rules are evaluated in order; the first matching rule's model is returned.
 * Match criteria: any of rule.match.keywords present in prompt (case-insensitive),
 * or any of rule.match.tools present in allowedToolNames.
 *
 * @returns The routed provider/model, or null to keep the primary model.
 */
export function resolveTaskRoutedModelRef(params: {
  cfg: OpenClawConfig | undefined;
  primaryProvider: string;
  primaryModel: string;
  prompt: string;
  allowedToolNames?: string[];
}): TaskRoutedModelRef | null {
  const routing = params.cfg?.agents?.defaults?.model?.routing as
    | AgentModelRoutingConfig
    | undefined;
  if (!routing?.enabled || !routing.rules?.length) {
    return null;
  }

  const promptLower = params.prompt.trim().toLowerCase();
  const allowedSet = new Set(
    (params.allowedToolNames ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
  );

  for (const rule of routing.rules) {
    const match = rule.match;
    if (!match) {
      continue;
    }

    let keywordMatch = false;
    if (match.keywords?.length && promptLower) {
      keywordMatch = match.keywords.some((k) => {
        const kw = String(k).trim().toLowerCase();
        return kw.length > 0 && promptLower.includes(kw);
      });
    }

    let toolMatch = false;
    if (match.tools?.length && allowedSet.size > 0) {
      toolMatch = match.tools.some((t) => {
        const tool = String(t).trim().toLowerCase();
        return tool.length > 0 && allowedSet.has(tool);
      });
    }

    if (!keywordMatch && !toolMatch) {
      continue;
    }

    const ref = parseModelRef(
      rule.model.trim(),
      params.primaryProvider,
    );
    if (ref) {
      return { provider: ref.provider, model: ref.model };
    }
  }

  return null;
}
