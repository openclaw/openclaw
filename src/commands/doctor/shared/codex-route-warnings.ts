import type {
  AgentModelConfig,
  AgentRuntimePolicyConfig,
} from "../../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

type CodexRouteHit = {
  path: string;
  model: string;
  runtime: string;
  canonicalModel: string;
  scope: "defaults" | "agent";
  agentId?: string;
  agentIndex?: number;
};

type AgentDefaultsConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function normalizeModelRef(model: AgentModelConfig | undefined): string | undefined {
  if (typeof model === "string") {
    return model.trim() || undefined;
  }
  return typeof model?.primary === "string" && model.primary.trim()
    ? model.primary.trim()
    : undefined;
}

function isOpenAICodexModelRef(model: string | undefined): model is string {
  return normalizeString(model)?.startsWith("openai-codex/") === true;
}

function toCanonicalOpenAIModelRef(model: string): string | undefined {
  if (!isOpenAICodexModelRef(model)) {
    return undefined;
  }
  const modelId = model.slice("openai-codex/".length).trim();
  return modelId ? `openai/${modelId}` : undefined;
}

function resolveRuntime(params: {
  env?: NodeJS.ProcessEnv;
  agentRuntime?: AgentRuntimePolicyConfig;
  defaultsRuntime?: AgentRuntimePolicyConfig;
}): string {
  return (
    normalizeString(params.env?.OPENCLAW_AGENT_RUNTIME) ??
    normalizeString(params.agentRuntime?.id) ??
    normalizeString(params.defaultsRuntime?.id) ??
    "pi"
  );
}

function collectOpenAICodexRouteHits(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): CodexRouteHit[] {
  const defaults = cfg.agents?.defaults;
  const defaultsRuntime = defaults?.agentRuntime;
  const hits: CodexRouteHit[] = [];
  const defaultModel = normalizeModelRef(defaults?.model);
  const defaultRuntime = resolveRuntime({ env, defaultsRuntime });
  if (isOpenAICodexModelRef(defaultModel)) {
    const canonicalModel = toCanonicalOpenAIModelRef(defaultModel);
    if (canonicalModel) {
      hits.push({
        path: "agents.defaults.model",
        model: defaultModel,
        runtime: defaultRuntime,
        canonicalModel,
        scope: "defaults",
      });
    }
  }

  for (const [index, agent] of (cfg.agents?.list ?? []).entries()) {
    const model = normalizeModelRef(agent.model);
    if (!isOpenAICodexModelRef(model)) {
      continue;
    }
    const canonicalModel = toCanonicalOpenAIModelRef(model);
    if (!canonicalModel) {
      continue;
    }
    const runtime = resolveRuntime({
      env,
      agentRuntime: agent.agentRuntime,
      defaultsRuntime,
    });
    const id = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : "<unknown>";
    hits.push({
      path: `agents.list.${id}.model`,
      model,
      runtime,
      canonicalModel,
      scope: "agent",
      agentId: id,
      agentIndex: index,
    });
  }

  return hits;
}

function rewriteModelPrimary(
  model: AgentModelConfig | undefined,
  canonicalModel: string,
): AgentModelConfig {
  if (model && typeof model === "object") {
    return { ...model, primary: canonicalModel };
  }
  return canonicalModel;
}

function upsertDefaultModelAllowlist(
  cfg: OpenClawConfig,
  hits: readonly CodexRouteHit[],
): AgentDefaultsConfig {
  const defaults = cfg.agents?.defaults ?? {};
  const models = { ...defaults.models };
  for (const hit of hits) {
    models[hit.canonicalModel] = models[hit.canonicalModel] ?? models[hit.model] ?? {};
  }
  return { ...defaults, models };
}

function repairCodexRoutes(
  cfg: OpenClawConfig,
  hits: readonly CodexRouteHit[],
): { cfg: OpenClawConfig; changes: string[] } {
  if (hits.length === 0) {
    return { cfg, changes: [] };
  }
  const defaultHit = hits.find((hit) => hit.scope === "defaults");
  const agentHits = hits.filter((hit) => hit.scope === "agent");
  const defaults = upsertDefaultModelAllowlist(cfg, hits);
  const repairedAgents = (cfg.agents?.list ?? []).map((agent, index) => {
    const hit = agentHits.find((entry) => entry.agentIndex === index);
    if (!hit) {
      return agent;
    }
    return Object.assign({}, agent, {
      model: rewriteModelPrimary(agent.model, hit.canonicalModel),
      agentRuntime: Object.assign({}, agent.agentRuntime, {
        id: "auto",
      }),
    });
  });
  const nextDefaults = defaultHit
    ? {
        ...defaults,
        model: rewriteModelPrimary(defaults.model, defaultHit.canonicalModel),
        agentRuntime: {
          ...defaults.agentRuntime,
          id: "auto",
        },
      }
    : defaults;
  const nextConfig: OpenClawConfig = {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: nextDefaults,
      ...(cfg.agents?.list ? { list: repairedAgents } : {}),
    },
  };
  return {
    cfg: nextConfig,
    changes: hits.map(
      (hit) => `${hit.path}: ${hit.model} -> ${hit.canonicalModel}; set agentRuntime.id to "auto".`,
    ),
  };
}

export function collectCodexRouteWarnings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const hits = collectOpenAICodexRouteHits(params.cfg, params.env);
  if (hits.length === 0) {
    return [];
  }
  return [
    [
      '- Legacy `openai-codex/*` primary model refs should be rewritten to `openai/*` with `agentRuntime.id: "auto"`.',
      ...hits.map(
        (hit) =>
          `- ${hit.path}: ${hit.model} should become ${hit.canonicalModel}; current runtime is "${hit.runtime}".`,
      ),
      '- Run `openclaw doctor --fix` to set the runtime to "auto": Codex claims the turn when installed, otherwise PI remains the fallback.',
    ].join("\n"),
  ];
}

export function maybeRepairCodexRoutes(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
}): { cfg: OpenClawConfig; warnings: string[]; changes: string[] } {
  const hits = collectOpenAICodexRouteHits(params.cfg, params.env);
  if (hits.length === 0) {
    return { cfg: params.cfg, warnings: [], changes: [] };
  }
  if (!params.shouldRepair) {
    return {
      cfg: params.cfg,
      warnings: collectCodexRouteWarnings({ cfg: params.cfg, env: params.env }),
      changes: [],
    };
  }
  const repaired = repairCodexRoutes(params.cfg, hits);
  return {
    cfg: repaired.cfg,
    warnings: [],
    changes: [
      `Repaired Codex model routes:\n${repaired.changes.map((line) => `- ${line}`).join("\n")}`,
    ],
  };
}
