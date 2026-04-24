import { ensurePluginAllowlisted } from "../../../config/plugins-allowlist.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRegistry,
} from "../../../plugins/manifest-registry.js";

const CODEX_PLUGIN_ID = "codex";
const OPENAI_PLUGIN_ID = "openai";
const OPENAI_ENABLED_CODEX_REASON = "OpenAI plugin enabled";

export type ConfiguredPluginAutoEnableBlockerReason = "blocked-by-denylist" | "not-enabled";

export type ConfiguredPluginAutoEnableBlockerHit = {
  pluginId: typeof CODEX_PLUGIN_ID;
  reasons: [typeof OPENAI_ENABLED_CODEX_REASON];
  blocker: ConfiguredPluginAutoEnableBlockerReason;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isPluginDenied(cfg: OpenClawConfig, pluginId: string): boolean {
  return Array.isArray(cfg.plugins?.deny) && cfg.plugins.deny.includes(pluginId);
}

function isPluginEntryDisabled(cfg: OpenClawConfig, pluginId: string): boolean {
  return cfg.plugins?.entries?.[pluginId]?.enabled === false;
}

function isPluginEntryEnabled(cfg: OpenClawConfig, pluginId: string): boolean {
  return cfg.plugins?.entries?.[pluginId]?.enabled === true;
}

function isPluginAllowMissing(cfg: OpenClawConfig, pluginId: string): boolean {
  return Array.isArray(cfg.plugins?.allow) && !cfg.plugins.allow.includes(pluginId);
}

function isOpenAiExplicitlyEnabled(cfg: OpenClawConfig): boolean {
  if (cfg.plugins?.enabled === false || isPluginDenied(cfg, OPENAI_PLUGIN_ID)) {
    return false;
  }
  if (isPluginEntryDisabled(cfg, OPENAI_PLUGIN_ID)) {
    return false;
  }
  if (isPluginAllowMissing(cfg, OPENAI_PLUGIN_ID)) {
    return false;
  }
  return (
    isPluginEntryEnabled(cfg, OPENAI_PLUGIN_ID) ||
    cfg.plugins?.allow?.includes(OPENAI_PLUGIN_ID) === true
  );
}

function isCodexEnabled(cfg: OpenClawConfig): boolean {
  if (isPluginDenied(cfg, CODEX_PLUGIN_ID)) {
    return false;
  }
  if (!isPluginEntryEnabled(cfg, CODEX_PLUGIN_ID)) {
    return false;
  }
  return !isPluginAllowMissing(cfg, CODEX_PLUGIN_ID);
}

function resolveRegistry(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): PluginManifestRegistry {
  return (
    params.manifestRegistry ??
    loadPluginManifestRegistry({
      config: params.cfg,
      env: params.env,
    })
  );
}

function hasCodexManifest(registry: PluginManifestRegistry): boolean {
  return registry.plugins.some((plugin) => plugin.id === CODEX_PLUGIN_ID);
}

function shouldEnableCodexForOpenAi(
  cfg: OpenClawConfig,
  registry: PluginManifestRegistry,
): boolean {
  return isOpenAiExplicitlyEnabled(cfg) && !isCodexEnabled(cfg) && hasCodexManifest(registry);
}

function setCodexEntryEnabled(cfg: OpenClawConfig): OpenClawConfig {
  const entry = cfg.plugins?.entries?.[CODEX_PLUGIN_ID];
  const existingEntry = isRecord(entry) ? entry : {};
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        [CODEX_PLUGIN_ID]: {
          ...existingEntry,
          enabled: true,
        },
      },
    },
  };
}

export function scanConfiguredPluginAutoEnableBlockers(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): ConfiguredPluginAutoEnableBlockerHit[] {
  const registry = resolveRegistry(params);
  if (!shouldEnableCodexForOpenAi(params.cfg, registry)) {
    return [];
  }
  return [
    {
      pluginId: CODEX_PLUGIN_ID,
      reasons: [OPENAI_ENABLED_CODEX_REASON],
      blocker: isPluginDenied(params.cfg, CODEX_PLUGIN_ID) ? "blocked-by-denylist" : "not-enabled",
    },
  ];
}

export function collectConfiguredPluginAutoEnableBlockerWarnings(params: {
  hits: readonly ConfiguredPluginAutoEnableBlockerHit[];
  doctorFixCommand?: string;
}): string[] {
  return params.hits.map((hit) => {
    if (hit.blocker === "blocked-by-denylist") {
      return `- plugins.deny: plugin "${hit.pluginId}" is denied, but ${hit.reasons[0]}. Remove it from plugins.deny before relying on that configuration.`;
    }
    const suffix = params.doctorFixCommand
      ? ` Run "${params.doctorFixCommand}" to enable it.`
      : " Enable the plugin before relying on that configuration.";
    return `- plugins.entries.${hit.pluginId}.enabled: plugin is not enabled, but ${hit.reasons[0]}.${suffix}`;
  });
}

export function maybeRepairConfiguredPluginAutoEnableBlockers(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): {
  config: OpenClawConfig;
  changes: string[];
  warnings: string[];
} {
  const hits = scanConfiguredPluginAutoEnableBlockers(params);
  if (hits.length === 0) {
    return { config: params.cfg, changes: [], warnings: [] };
  }
  const hit = hits[0];
  if (hit.blocker === "blocked-by-denylist") {
    return {
      config: params.cfg,
      changes: [],
      warnings: collectConfiguredPluginAutoEnableBlockerWarnings({ hits }),
    };
  }

  const hadAllowlistMissing = isPluginAllowMissing(params.cfg, CODEX_PLUGIN_ID);
  const config = ensurePluginAllowlisted(setCodexEntryEnabled(params.cfg), CODEX_PLUGIN_ID);
  const changes = [
    `plugins.entries.${CODEX_PLUGIN_ID}.enabled: enabled plugin because ${OPENAI_ENABLED_CODEX_REASON}.`,
  ];
  if (hadAllowlistMissing) {
    changes.push(
      `plugins.allow: added "${CODEX_PLUGIN_ID}" because ${OPENAI_ENABLED_CODEX_REASON}.`,
    );
  }
  return { config, changes, warnings: [] };
}
