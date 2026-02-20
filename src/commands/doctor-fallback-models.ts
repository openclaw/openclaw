import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { modelKey, normalizeProviderId, parseModelRef } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import { note } from "../terminal/note.js";

type FallbackRef = {
  raw: string;
  provider: string;
  model: string;
  source: string;
};

/**
 * Collect all fallback model references from config.
 */
function collectFallbackRefs(cfg: OpenClawConfig): FallbackRef[] {
  const refs: FallbackRef[] = [];
  const defaultProvider = DEFAULT_PROVIDER;

  const addRefs = (fallbacks: unknown, source: string) => {
    if (!Array.isArray(fallbacks)) {
      return;
    }
    for (const raw of fallbacks) {
      if (typeof raw !== "string" || !raw.trim()) {
        continue;
      }
      const parsed = parseModelRef(raw, defaultProvider);
      if (!parsed) {
        continue;
      }
      refs.push({
        raw,
        provider: parsed.provider,
        model: parsed.model,
        source,
      });
    }
  };

  // agents.defaults.model.fallbacks
  const modelConfig = cfg.agents?.defaults?.model;
  if (modelConfig && typeof modelConfig === "object") {
    addRefs((modelConfig as { fallbacks?: string[] }).fallbacks, "agents.defaults.model.fallbacks");
  }

  // agents.defaults.imageModel.fallbacks
  const imageModelConfig = cfg.agents?.defaults?.imageModel;
  if (imageModelConfig && typeof imageModelConfig === "object") {
    addRefs(
      (imageModelConfig as { fallbacks?: string[] }).fallbacks,
      "agents.defaults.imageModel.fallbacks",
    );
  }

  // Per-agent fallbacks: agents.list[].model.fallbacks and agents.list[].subagents.model.fallbacks
  const agentList = cfg.agents?.list ?? [];
  for (const agent of agentList) {
    const agentId = agent.id ?? "unknown";
    const agentModel = agent.model;
    if (agentModel && typeof agentModel === "object") {
      addRefs(
        (agentModel as { fallbacks?: string[] }).fallbacks,
        `agents.list[${agentId}].model.fallbacks`,
      );
    }
    const agentSubagentModel = agent.subagents?.model;
    if (agentSubagentModel && typeof agentSubagentModel === "object") {
      addRefs(
        (agentSubagentModel as { fallbacks?: string[] }).fallbacks,
        `agents.list[${agentId}].subagents.model.fallbacks`,
      );
    }
  }

  // agents.defaults.subagents.model.fallbacks
  const subagentModel = cfg.agents?.defaults?.subagents?.model;
  if (subagentModel && typeof subagentModel === "object") {
    addRefs(
      (subagentModel as { fallbacks?: string[] }).fallbacks,
      "agents.defaults.subagents.model.fallbacks",
    );
  }

  return refs;
}

/**
 * Build a set of provider IDs that are known to be available:
 * - Providers in the model catalog (built-in + discovered)
 * - Providers explicitly configured in models.providers
 * - CLI backends
 */
async function buildKnownProviderIds(cfg: OpenClawConfig): Promise<Set<string>> {
  const known = new Set<string>();

  // From model catalog (includes built-in providers like anthropic, google, openai, etc.)
  try {
    const catalog = await loadModelCatalog({ config: cfg });
    for (const entry of catalog) {
      known.add(normalizeProviderId(entry.provider));
    }
  } catch {
    // If catalog loading fails, continue with explicit providers only.
  }

  // From explicit models.providers config
  const providers = cfg.models?.providers ?? {};
  for (const key of Object.keys(providers)) {
    known.add(normalizeProviderId(key));
  }

  // CLI backends
  const cliBackends = cfg.agents?.defaults?.cliBackends ?? {};
  for (const key of Object.keys(cliBackends)) {
    known.add(normalizeProviderId(key));
  }

  return known;
}

/**
 * Validate that all fallback model providers are resolvable.
 * Emits doctor notes for any misconfigured fallback references.
 */
export async function noteFallbackModelHealth(cfg: OpenClawConfig): Promise<void> {
  const refs = collectFallbackRefs(cfg);
  if (refs.length === 0) {
    return;
  }

  const knownProviders = await buildKnownProviderIds(cfg);
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    const key = modelKey(ref.provider, ref.model);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const normalizedProvider = normalizeProviderId(ref.provider);
    if (!knownProviders.has(normalizedProvider)) {
      warnings.push(
        `- "${ref.raw}" in ${ref.source}: provider "${ref.provider}" is not defined in models.providers and not found in the model catalog.`,
      );
    }
  }

  if (warnings.length === 0) {
    return;
  }

  note(
    [
      "Fallback model chain references undefined providers.",
      "These fallbacks will fail at runtime when the primary model is unavailable.",
      "",
      ...warnings,
      "",
      "Fix: add the missing provider to models.providers in your config,",
      "or run: openclaw auth add --provider <provider-name>",
    ].join("\n"),
    "Fallback models",
  );
}
