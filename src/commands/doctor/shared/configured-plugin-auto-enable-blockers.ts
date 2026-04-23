import {
  detectPluginAutoEnableCandidates,
  resolvePluginAutoEnableCandidateReason,
  type PluginAutoEnableCandidate,
} from "../../../config/plugin-auto-enable.js";
import { ensurePluginAllowlisted } from "../../../config/plugins-allowlist.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../../../plugins/manifest-registry.js";

const REPAIRABLE_CANDIDATE_KINDS = new Set<PluginAutoEnableCandidate["kind"]>([
  "provider-auth-configured",
  "provider-model-configured",
  "agent-harness-runtime-configured",
]);
const OPENAI_ENABLED_CODEX_REASON = "OpenAI plugin enabled";

export type ConfiguredPluginAutoEnableBlockerReason =
  | "disabled-in-config"
  | "blocked-by-denylist"
  | "plugins-disabled"
  | "not-enabled";

export type ConfiguredPluginAutoEnableBlockerHit = {
  pluginId: string;
  reasons: string[];
  blocker: ConfiguredPluginAutoEnableBlockerReason;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isRepairableCandidate(candidate: PluginAutoEnableCandidate): boolean {
  return REPAIRABLE_CANDIDATE_KINDS.has(candidate.kind);
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
  if (cfg.plugins?.enabled === false || isPluginDenied(cfg, "openai")) {
    return false;
  }
  if (isPluginEntryDisabled(cfg, "openai")) {
    return false;
  }
  if (isPluginAllowMissing(cfg, "openai")) {
    return false;
  }
  return isPluginEntryEnabled(cfg, "openai") || cfg.plugins?.allow?.includes("openai") === true;
}

function isCodexAlreadyEnabled(cfg: OpenClawConfig): boolean {
  if (!isPluginEntryEnabled(cfg, "codex")) {
    return false;
  }
  return !isPluginAllowMissing(cfg, "codex");
}

function shouldEnableCodexForOpenAi(cfg: OpenClawConfig): boolean {
  return isOpenAiExplicitlyEnabled(cfg) && !isCodexAlreadyEnabled(cfg);
}

function setPluginEntryEnabled(cfg: OpenClawConfig, pluginId: string): OpenClawConfig {
  const entry = cfg.plugins?.entries?.[pluginId];
  const existingEntry = isRecord(entry) ? entry : {};
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        [pluginId]: {
          ...existingEntry,
          enabled: true,
        },
      },
    },
  };
}

function joinReasons(reasons: readonly string[]): string {
  return reasons.join("; ");
}

function addReason(reasonsByPlugin: Map<string, string[]>, pluginId: string, reason: string): void {
  const reasons = reasonsByPlugin.get(pluginId) ?? [];
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
  reasonsByPlugin.set(pluginId, reasons);
}

export function scanConfiguredPluginAutoEnableBlockers(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): ConfiguredPluginAutoEnableBlockerHit[] {
  const candidates = detectPluginAutoEnableCandidates({
    config: params.cfg,
    env: params.env,
    manifestRegistry: params.manifestRegistry,
  }).filter(isRepairableCandidate);

  const reasonsByPlugin = new Map<string, string[]>();
  for (const candidate of candidates) {
    addReason(
      reasonsByPlugin,
      candidate.pluginId,
      resolvePluginAutoEnableCandidateReason(candidate),
    );
  }
  if (shouldEnableCodexForOpenAi(params.cfg)) {
    addReason(reasonsByPlugin, "codex", OPENAI_ENABLED_CODEX_REASON);
  }
  if (reasonsByPlugin.size === 0) {
    return [];
  }

  const hits: ConfiguredPluginAutoEnableBlockerHit[] = [];
  for (const pluginId of [...reasonsByPlugin.keys()].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    const reasons = reasonsByPlugin.get(pluginId) ?? [];
    if (params.cfg.plugins?.enabled === false) {
      hits.push({ pluginId, reasons, blocker: "plugins-disabled" });
      continue;
    }
    if (isPluginDenied(params.cfg, pluginId)) {
      hits.push({ pluginId, reasons, blocker: "blocked-by-denylist" });
      continue;
    }
    if (isPluginEntryDisabled(params.cfg, pluginId)) {
      hits.push({ pluginId, reasons, blocker: "disabled-in-config" });
      continue;
    }
    if (pluginId === "codex" && reasons.includes(OPENAI_ENABLED_CODEX_REASON)) {
      hits.push({ pluginId, reasons, blocker: "not-enabled" });
    }
  }
  return hits;
}

export function collectConfiguredPluginAutoEnableBlockerWarnings(params: {
  hits: readonly ConfiguredPluginAutoEnableBlockerHit[];
  doctorFixCommand?: string;
}): string[] {
  return params.hits.map((hit) => {
    const reason = joinReasons(hit.reasons);
    if (hit.blocker === "disabled-in-config") {
      const suffix = params.doctorFixCommand
        ? ` Run "${params.doctorFixCommand}" to enable it.`
        : " Enable the plugin before relying on that configuration.";
      return `- plugins.entries.${hit.pluginId}.enabled: plugin is disabled, but ${reason}.${suffix}`;
    }
    if (hit.blocker === "not-enabled") {
      const suffix = params.doctorFixCommand
        ? ` Run "${params.doctorFixCommand}" to enable it.`
        : " Enable the plugin before relying on that configuration.";
      return `- plugins.entries.${hit.pluginId}.enabled: plugin is not enabled, but ${reason}.${suffix}`;
    }
    if (hit.blocker === "blocked-by-denylist") {
      return `- plugins.deny: plugin "${hit.pluginId}" is denied, but ${reason}. Remove it from plugins.deny before relying on that configuration.`;
    }
    return `- plugins.enabled: plugins are disabled globally, but plugin "${hit.pluginId}" is needed because ${reason}. Enable plugins before relying on that configuration.`;
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
  let next = params.cfg;
  const changes: string[] = [];
  const warnings: string[] = [];
  const hits = scanConfiguredPluginAutoEnableBlockers(params);

  for (const hit of hits) {
    if (hit.blocker !== "disabled-in-config" && hit.blocker !== "not-enabled") {
      warnings.push(...collectConfiguredPluginAutoEnableBlockerWarnings({ hits: [hit] }));
      continue;
    }

    const hadAllowlistMissing = isPluginAllowMissing(next, hit.pluginId);
    next = setPluginEntryEnabled(next, hit.pluginId);
    next = ensurePluginAllowlisted(next, hit.pluginId);
    const reason = joinReasons(hit.reasons);
    changes.push(`plugins.entries.${hit.pluginId}.enabled: enabled plugin because ${reason}.`);
    if (hadAllowlistMissing) {
      changes.push(`plugins.allow: added "${hit.pluginId}" because ${reason}.`);
    }
  }

  return { config: next, changes, warnings };
}
