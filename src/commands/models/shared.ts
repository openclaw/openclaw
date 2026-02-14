import { listAgentIds } from "../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  buildModelAliasIndex,
  modelKey,
  parseModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { formatCliCommand } from "../../cli/command-format.js";
import {
  type OpenClawConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";

export const ensureFlagCompatibility = (opts: { json?: boolean; plain?: boolean }) => {
  if (opts.json && opts.plain) {
    throw new Error("Choose either --json or --plain, not both.");
  }
};

export const formatTokenK = (value?: number | null) => {
  if (!value || !Number.isFinite(value)) {
    return "-";
  }
  if (value < 1024) {
    return `${Math.round(value)}`;
  }
  return `${Math.round(value / 1024)}k`;
};

export const formatMs = (value?: number | null) => {
  if (value === null || value === undefined) {
    return "-";
  }
  if (!Number.isFinite(value)) {
    return "-";
  }
  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }
  return `${Math.round(value / 100) / 10}s`;
};

export const isLocalBaseUrl = (baseUrl: string) => {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
};

export async function updateConfig(
  mutator: (cfg: OpenClawConfig) => OpenClawConfig,
): Promise<OpenClawConfig> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    const issues = snapshot.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
    throw new Error(`Invalid config at ${snapshot.path}\n${issues}`);
  }
  const next = mutator(snapshot.config);
  await writeConfigFile(next);
  return next;
}

export function resolveModelTarget(params: { raw: string; cfg: OpenClawConfig }): {
  provider: string;
  model: string;
} {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const resolved = resolveModelRefFromString({
    raw: params.raw,
    defaultProvider: DEFAULT_PROVIDER,
    aliasIndex,
  });
  if (!resolved) {
    throw new Error(`Invalid model reference: ${params.raw}`);
  }
  return resolved.ref;
}

export function buildAllowlistSet(cfg: OpenClawConfig): Set<string> {
  const allowed = new Set<string>();
  const models = cfg.agents?.defaults?.models ?? {};
  for (const raw of Object.keys(models)) {
    const parsed = parseModelRef(String(raw ?? ""), DEFAULT_PROVIDER);
    if (!parsed) {
      continue;
    }
    allowed.add(modelKey(parsed.provider, parsed.model));
  }
  return allowed;
}

export function normalizeAlias(alias: string): string {
  const trimmed = alias.trim();
  if (!trimmed) {
    throw new Error("Alias cannot be empty.");
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(trimmed)) {
    throw new Error("Alias must use letters, numbers, dots, underscores, colons, or dashes.");
  }
  return trimmed;
}

export function resolveKnownAgentId(params: {
  cfg: OpenClawConfig;
  rawAgentId?: string | null;
}): string | undefined {
  const raw = params.rawAgentId?.trim();
  if (!raw) {
    return undefined;
  }
  const agentId = normalizeAgentId(raw);
  const knownAgents = listAgentIds(params.cfg);
  if (!knownAgents.includes(agentId)) {
    throw new Error(
      `Unknown agent id "${raw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`,
    );
  }
  return agentId;
}

export { modelKey };
export { DEFAULT_MODEL, DEFAULT_PROVIDER };

/**
 * Model key format: "provider/model"
 *
 * The model key is displayed in `/model status` and used to reference models.
 * When using `/model <key>`, use the exact format shown (e.g., "openrouter/moonshotai/kimi-k2").
 *
 * For providers with hierarchical model IDs (e.g., OpenRouter), the model ID may include
 * sub-providers (e.g., "moonshotai/kimi-k2"), resulting in a key like "openrouter/moonshotai/kimi-k2".
 */
