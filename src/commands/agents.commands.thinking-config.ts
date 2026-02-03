import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { lookupContextTokens } from "../agents/context.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveThinkingTokenBudget } from "../agents/thinking-budgets.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { requireValidConfig } from "./agents.command-shared.js";
import { listAgentEntries } from "./agents.config.js";

type AgentsThinkingConfigOptions = {
  json?: boolean;
  agent?: string;
};

type AgentThinkingConfig = {
  id: string;
  name?: string;
  model: {
    provider: string;
    id: string;
    full: string;
  };
  runtime: "pi" | "claude" | undefined;
  thinking: {
    effective: string;
    source: "per-agent" | "global-default" | "model-default";
    budget: number;
    budgets: {
      off: number;
      minimal: number;
      low: number;
      medium: number;
      high: number;
      xhigh: number;
    };
  };
  verbose: {
    effective: string;
    source: "per-agent" | "global-default" | "none";
  };
  context: {
    window: number;
    source: string;
  };
};

async function buildAgentThinkingConfig(
  cfg: OpenClawConfig,
  agentId: string,
): Promise<AgentThinkingConfig | null> {
  const entries = listAgentEntries(cfg);
  const entry = entries.find((e) => normalizeAgentId(e.id) === normalizeAgentId(agentId));
  if (!entry) {
    return null;
  }

  // Resolve model
  const { provider, model: modelId } = resolveDefaultModelForAgent({
    cfg,
    agentId,
  });

  // Resolve thinking level
  const perAgentThinking = entry.thinkingDefault;
  const globalThinking = cfg.agents?.defaults?.thinkingDefault;
  const effectiveThinking = perAgentThinking ?? globalThinking ?? "off";
  const thinkingSource: "per-agent" | "global-default" | "model-default" = perAgentThinking
    ? "per-agent"
    : globalThinking
      ? "global-default"
      : "model-default";

  // Resolve verbose level
  const perAgentVerbose = entry.verboseDefault;
  const globalVerbose = cfg.agents?.defaults?.verboseDefault;
  const effectiveVerbose = perAgentVerbose ?? globalVerbose ?? "off";
  const verboseSource: "per-agent" | "global-default" | "none" = perAgentVerbose
    ? "per-agent"
    : globalVerbose
      ? "global-default"
      : "none";

  // Resolve context window
  const catalog = await loadModelCatalog({ config: cfg });
  const catalogEntry = catalog.find((m) => m.provider === provider && m.id === modelId);
  const contextWindow = catalogEntry?.contextWindow ?? lookupContextTokens(modelId) ?? 128_000;
  const contextSource = catalogEntry ? "model-catalog" : "config-override";

  // Get all budget levels
  const budgets = {
    off: resolveThinkingTokenBudget(provider, modelId, "off"),
    minimal: resolveThinkingTokenBudget(provider, modelId, "minimal"),
    low: resolveThinkingTokenBudget(provider, modelId, "low"),
    medium: resolveThinkingTokenBudget(provider, modelId, "medium"),
    high: resolveThinkingTokenBudget(provider, modelId, "high"),
    xhigh: resolveThinkingTokenBudget(provider, modelId, "xhigh"),
  };

  return {
    id: agentId,
    name: entry.name,
    model: {
      provider,
      id: modelId,
      full: `${provider}/${modelId}`,
    },
    runtime: entry.runtime ?? cfg.agents?.defaults?.runtime,
    thinking: {
      effective: effectiveThinking,
      source: thinkingSource,
      budget: budgets[effectiveThinking as keyof typeof budgets],
      budgets,
    },
    verbose: {
      effective: effectiveVerbose,
      source: verboseSource,
    },
    context: {
      window: contextWindow,
      source: contextSource,
    },
  };
}

function formatThinkingConfig(config: AgentThinkingConfig): string {
  const lines: string[] = [];

  lines.push(`Agent: ${config.id}${config.name ? ` (${config.name})` : ""}`);
  lines.push(`Model: ${config.model.full}`);
  if (config.runtime) {
    lines.push(`Runtime: ${config.runtime}`);
  }
  lines.push("");

  // Thinking configuration
  lines.push(`Thinking Level: ${config.thinking.effective} (${config.thinking.source})`);
  lines.push(`Current Budget: ${config.thinking.budget.toLocaleString()} tokens`);
  lines.push("");
  lines.push("Token Budgets by Level:");
  lines.push(`  off:     ${config.thinking.budgets.off.toLocaleString().padStart(7)} tokens`);
  lines.push(`  minimal: ${config.thinking.budgets.minimal.toLocaleString().padStart(7)} tokens`);
  lines.push(
    `  low:     ${config.thinking.budgets.low.toLocaleString().padStart(7)} tokens${config.thinking.effective === "low" ? " ← current" : ""}`,
  );
  lines.push(
    `  medium:  ${config.thinking.budgets.medium.toLocaleString().padStart(7)} tokens${config.thinking.effective === "medium" ? " ← current" : ""}`,
  );
  lines.push(
    `  high:    ${config.thinking.budgets.high.toLocaleString().padStart(7)} tokens${config.thinking.effective === "high" ? " ← current" : ""}`,
  );
  lines.push(
    `  xhigh:   ${config.thinking.budgets.xhigh.toLocaleString().padStart(7)} tokens${config.thinking.effective === "xhigh" ? " ← current" : ""}`,
  );
  lines.push("");

  // Verbose configuration
  lines.push(`Verbose Level: ${config.verbose.effective} (${config.verbose.source})`);
  lines.push("");

  // Context window
  lines.push(
    `Context Window: ${config.context.window.toLocaleString()} tokens (${config.context.source})`,
  );

  return lines.join("\n");
}

export async function agentsThinkingConfigCommand(
  opts: AgentsThinkingConfigOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const agentId = opts.agent ? normalizeAgentId(opts.agent) : undefined;

  if (agentId) {
    // Show config for specific agent
    const config = await buildAgentThinkingConfig(cfg, agentId);
    if (!config) {
      runtime.error(`Agent not found: ${agentId}`);
      process.exitCode = 1;
      return;
    }

    if (opts.json) {
      runtime.log(JSON.stringify(config, null, 2));
    } else {
      runtime.log(formatThinkingConfig(config));
    }
  } else {
    // Show config for all agents
    const entries = listAgentEntries(cfg);
    const configs: AgentThinkingConfig[] = [];

    for (const entry of entries) {
      const config = await buildAgentThinkingConfig(cfg, entry.id);
      if (config) {
        configs.push(config);
      }
    }

    if (opts.json) {
      runtime.log(JSON.stringify(configs, null, 2));
    } else {
      const sections = configs.map(formatThinkingConfig);
      runtime.log(sections.join("\n\n---\n\n"));
      runtime.log("");
      runtime.log(`Total agents: ${configs.length}`);
      runtime.log(`Use --agent <id> to show config for a specific agent.`);
    }
  }
}
