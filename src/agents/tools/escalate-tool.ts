import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { normalizeProviderId } from "../model-selection.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const EscalateSchema = Type.Object({
  reason: Type.String(),
});

/**
 * Create the `escalate` tool that lets a lighter model hand off to
 * a more capable one mid-turn.
 *
 * When called, the tool invokes the `onEscalate` callback. The caller
 * (attempt.ts) captures the reason in a local variable and returns it
 * in the attempt result — no global state needed.
 */
export function createEscalateTool(params: { onEscalate: (reason: string) => void }): AnyAgentTool {
  return {
    label: "Escalate",
    name: "escalate",
    description:
      "Escalate this conversation turn to a more capable model. Use this IMMEDIATELY as your first action — before generating any text — when the task requires deep reasoning, complex multi-step analysis, nuanced judgement, creative writing, debugging intricate issues, or when you are uncertain about factual accuracy. Do NOT use this for simple greetings, short answers, or straightforward tasks you can handle confidently.",
    parameters: EscalateSchema,
    execute: async (_toolCallId, rawParams) => {
      const reason = readStringParam(rawParams as Record<string, unknown>, "reason", {
        required: true,
      });
      params.onEscalate(reason);
      return jsonResult({ escalated: true, reason });
    },
  };
}

/**
 * Parse the escalation model reference from config into provider + model + ref.
 * Checks per-agent config first, then falls back to global defaults.
 * Returns undefined if no escalation model is configured or the ref is invalid.
 */
export function resolveEscalationModel(
  config?: OpenClawConfig,
  agentId?: string,
): { provider: string; model: string; ref: string } | undefined {
  const raw =
    (agentId ? resolveAgentEscalation(config, agentId) : undefined) ??
    resolveDefaultEscalation(config);
  return parseEscalationRef(raw);
}

function resolveDefaultEscalation(config?: OpenClawConfig): string | undefined {
  const modelCfg = config?.agents?.defaults?.model;
  if (!modelCfg || typeof modelCfg === "string") {
    return undefined;
  }
  return modelCfg.escalation;
}

function resolveAgentEscalation(config?: OpenClawConfig, agentId?: string): string | undefined {
  if (!config || !agentId) {
    return undefined;
  }
  const agentCfg = resolveAgentConfig(config, agentId);
  const modelCfg = agentCfg?.model;
  if (!modelCfg || typeof modelCfg === "string") {
    return undefined;
  }
  return modelCfg.escalation;
}

function parseEscalationRef(
  raw?: string,
): { provider: string; model: string; ref: string } | undefined {
  const ref = raw?.trim();
  if (!ref) {
    return undefined;
  }
  const slash = ref.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const model = ref.slice(slash + 1);
  if (!model) {
    return undefined;
  }
  const provider = normalizeProviderId(ref.slice(0, slash));
  return { provider, model, ref: `${provider}/${model}` };
}
