import { resolveAgentModelFallbacksOverride } from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  buildModelAliasIndex,
  getModelRefStatus,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import { readConfigFileSnapshot, validateConfigObjectWithPlugins } from "../config/config.js";
import { formatConfigIssueLines, normalizeConfigIssues } from "../config/issue-format.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveTtsConfig, isTtsProviderConfigured, TTS_PROVIDERS } from "../tts/tts.js";

export type CheckConfigResult = {
  category: string;
  label: string;
  status: "ok" | "warn" | "fail";
  message?: string;
};

/**
 * Deep config validation that exercises subsystem initialization paths.
 * Goes beyond Zod schema validation to catch runtime config degradation.
 *
 * Two layers:
 * 1. Schema validation (fast, catches typos and structural errors)
 * 2. Subsystem dry-run checks (catches silent runtime failures)
 */
export async function runCheckConfig(): Promise<{
  results: CheckConfigResult[];
  hasFailures: boolean;
}> {
  const results: CheckConfigResult[] = [];

  // Layer 1: Schema validation
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.exists) {
    results.push({
      category: "schema",
      label: "Config file",
      status: "fail",
      message: "config file not found",
    });
    return { results, hasFailures: true };
  }

  if (!snapshot.valid) {
    const issues = normalizeConfigIssues(snapshot.issues);
    results.push({
      category: "schema",
      label: "Config schema",
      status: "fail",
      message: formatConfigIssueLines(issues, "", { normalizeRoot: true })
        .map((line) => line.trim())
        .filter(Boolean)
        .join("; "),
    });
    return { results, hasFailures: true };
  }

  // Surface snapshot-level warnings (e.g., unresolved ${ENV_VAR} substitutions)
  for (const warning of snapshot.warnings) {
    results.push({
      category: "schema",
      label: warning.path || "config",
      status: "warn",
      message: warning.message,
    });
  }

  // Schema passed — also run plugin-aware validation
  const pluginValidation = validateConfigObjectWithPlugins(snapshot.config);
  if (!pluginValidation.ok) {
    for (const issue of pluginValidation.issues) {
      results.push({
        category: "schema",
        label: issue.path || "config",
        status: "fail",
        message: issue.message,
      });
    }
  } else {
    results.push({
      category: "schema",
      label: "Config schema",
      status: "ok",
    });

    if ("warnings" in pluginValidation && Array.isArray(pluginValidation.warnings)) {
      for (const warning of pluginValidation.warnings) {
        results.push({
          category: "schema",
          label: warning.path || "config",
          status: "warn",
          message: warning.message,
        });
      }
    }
  }

  const cfg = snapshot.config;

  // Layer 2: Subsystem dry-run checks
  checkModelResolution(cfg, results);
  await checkModelCatalog(cfg, results);
  checkFallbackModels(cfg, results);
  checkTtsConfig(cfg, results);
  checkChannelConfig(cfg, results);

  const hasFailures = results.some((r) => r.status === "fail");
  return { results, hasFailures };
}

function checkModelResolution(cfg: OpenClawConfig, results: CheckConfigResult[]): void {
  try {
    // Check if the user explicitly configured a model that silently fell back
    const rawConfigured = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)?.trim();

    const { provider, model } = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });

    if (!provider || !model) {
      results.push({
        category: "model",
        label: "Primary model",
        status: "fail",
        message: "could not resolve primary model — check agents.defaults.model",
      });
      return;
    }

    // Detect silent fallback: user configured a model but resolution fell back to default
    if (rawConfigured && rawConfigured !== `${provider}/${model}` && !rawConfigured.includes("/")) {
      // User wrote a bare model name without provider — resolved but may not be what they intended
      results.push({
        category: "model",
        label: "Primary model",
        status: "warn",
        message: `"${rawConfigured}" resolved as ${provider}/${model} — consider using the full provider/model format`,
      });
      return;
    }
    if (rawConfigured && rawConfigured.includes("/")) {
      const parsed = parseModelRef(rawConfigured, DEFAULT_PROVIDER);
      if (parsed && (parsed.provider !== provider || parsed.model !== model)) {
        results.push({
          category: "model",
          label: "Primary model",
          status: "warn",
          message: `configured "${rawConfigured}" could not be resolved — fell back to ${provider}/${model}`,
        });
        return;
      }
    }

    results.push({
      category: "model",
      label: "Primary model",
      status: "ok",
      message: `${provider}/${model}`,
    });
  } catch (err) {
    results.push({
      category: "model",
      label: "Primary model",
      status: "fail",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function checkModelCatalog(cfg: OpenClawConfig, results: CheckConfigResult[]): Promise<void> {
  try {
    const catalog = await loadModelCatalog({ config: cfg });
    const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });

    // Use the already-resolved provider directly as the ref instead of re-parsing.
    // Re-parsing breaks models whose IDs contain "/" (e.g., OpenRouter refs like
    // "openrouter/anthropic/claude-sonnet-4-5" would be split incorrectly).
    const ref = { provider: defaultProvider, model: defaultModel };
    const status = getModelRefStatus({
      cfg,
      catalog,
      ref,
      defaultProvider,
      defaultModel,
    });
    if (!status.inCatalog) {
      results.push({
        category: "model",
        label: "Model catalog",
        status: "warn",
        message: `primary model "${status.key}" not in catalog (may fail at runtime)`,
      });
    } else {
      results.push({
        category: "model",
        label: "Model catalog",
        status: "ok",
      });
    }
  } catch (err) {
    results.push({
      category: "model",
      label: "Model catalog",
      status: "warn",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function checkFallbackModels(cfg: OpenClawConfig, results: CheckConfigResult[]): void {
  const { provider: defaultProvider } = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });

  // Collect all fallback refs: global defaults + per-agent overrides
  const globalFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
  const allFallbackSources: Array<{ source: string; fallbacks: string[] }> = [];

  if (globalFallbacks.length > 0) {
    allFallbackSources.push({
      source: "agents.defaults.model.fallbacks",
      fallbacks: globalFallbacks,
    });
  }

  if (Array.isArray(cfg.agents?.list)) {
    for (const agent of cfg.agents.list) {
      if (!agent?.id) {
        continue;
      }
      const override = resolveAgentModelFallbacksOverride(cfg, agent.id);
      if (override && override.length > 0) {
        allFallbackSources.push({
          source: `agents.list[${agent.id}].model.fallbacks`,
          fallbacks: override,
        });
      }
    }
  }

  if (allFallbackSources.length === 0) {
    results.push({
      category: "model",
      label: "Model fallbacks",
      status: "ok",
      message: "no fallbacks configured",
    });
    return;
  }

  // Use resolveModelRefFromString (same parser as runtime fallback execution)
  // which strips trailing auth-profile syntax and handles aliases.
  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider });

  let hasIssue = false;
  for (const { source, fallbacks } of allFallbackSources) {
    for (const fallback of fallbacks) {
      const raw = String(fallback).trim();
      if (!raw) {
        continue;
      }
      const resolved = resolveModelRefFromString({ raw, defaultProvider, aliasIndex });
      if (!resolved) {
        results.push({
          category: "model",
          label: "Model fallbacks",
          status: "fail",
          message: `${source}: could not resolve fallback "${fallback}"`,
        });
        hasIssue = true;
      }
    }
  }

  if (!hasIssue) {
    const totalCount = allFallbackSources.reduce((sum, s) => sum + s.fallbacks.length, 0);
    results.push({
      category: "model",
      label: "Model fallbacks",
      status: "ok",
      message: `${totalCount} fallback${totalCount === 1 ? "" : "s"} validated`,
    });
  }
}

function checkTtsConfig(cfg: OpenClawConfig, results: CheckConfigResult[]): void {
  try {
    const ttsConfig = resolveTtsConfig(cfg);

    if (ttsConfig.auto === "off") {
      results.push({
        category: "tts",
        label: "TTS",
        status: "ok",
        message: "disabled",
      });
      return;
    }

    // TTS is enabled — check if the configured provider is actually available
    const configuredProvider = ttsConfig.provider;
    const isConfigured = isTtsProviderConfigured(ttsConfig, configuredProvider);

    if (!isConfigured) {
      // Check if any fallback provider is available
      const availableFallback = TTS_PROVIDERS.find(
        (p) => p !== configuredProvider && isTtsProviderConfigured(ttsConfig, p),
      );

      const reason =
        configuredProvider === "edge"
          ? 'configured provider "edge" is disabled'
          : `configured provider "${configuredProvider}" missing API key`;

      if (availableFallback) {
        results.push({
          category: "tts",
          label: "TTS provider",
          status: "warn",
          message: `${reason} — will fall back to "${availableFallback}"`,
        });
      } else {
        results.push({
          category: "tts",
          label: "TTS provider",
          status: "fail",
          message: `${reason} and no fallback available`,
        });
      }
      return;
    }

    results.push({
      category: "tts",
      label: "TTS provider",
      status: "ok",
      message: configuredProvider,
    });
  } catch (err) {
    results.push({
      category: "tts",
      label: "TTS",
      status: "fail",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function checkChannelConfig(cfg: OpenClawConfig, results: CheckConfigResult[]): void {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object") {
    results.push({
      category: "channels",
      label: "Channels",
      status: "ok",
      message: "no channels configured",
    });
    return;
  }

  const channelEntries = Object.entries(channels).filter(
    ([key]) => key !== "defaults" && key !== "modelByChannel",
  );

  if (channelEntries.length === 0) {
    results.push({
      category: "channels",
      label: "Channels",
      status: "ok",
      message: "no channels configured",
    });
    return;
  }

  let enabledCount = 0;
  for (const [channelId, channelConfig] of channelEntries) {
    if (!channelConfig || typeof channelConfig !== "object") {
      continue;
    }
    const config = channelConfig as Record<string, unknown>;
    const enabled = config.enabled !== false;
    if (!enabled) {
      continue;
    }
    enabledCount++;
    results.push({
      category: "channels",
      label: `Channel: ${channelId}`,
      status: "ok",
      message: "enabled",
    });
  }

  if (enabledCount === 0) {
    results.push({
      category: "channels",
      label: "Channels",
      status: "ok",
      message: "all channels disabled",
    });
  }
}

/**
 * Format check-config results for terminal output.
 */
export function formatCheckConfigResults(results: CheckConfigResult[]): string[] {
  const lines: string[] = [];
  for (const result of results) {
    const icon =
      result.status === "ok" ? "\u2705" : result.status === "warn" ? "\u26A0\uFE0F" : "\u274C";
    const detail = result.message ? ` \u2014 ${result.message}` : "";
    lines.push(`${icon} ${result.label}${detail}`);
  }
  return lines;
}
