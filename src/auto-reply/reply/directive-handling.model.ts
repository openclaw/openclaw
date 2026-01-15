import { resolveAuthStorePathForDisplay } from "../../agents/auth-profiles.js";
import {
  type ModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { shortenHomePath } from "../../utils.js";
import type { ReplyPayload } from "../types.js";
import {
  formatAuthLabel,
  type ModelAuthDetailMode,
  resolveAuthLabel,
  resolveProfileOverride,
} from "./directive-handling.auth.js";
import {
  buildModelPickerItems,
  type ModelPickerCatalogEntry,
  resolveProviderEndpointLabel,
} from "./directive-handling.model-picker.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { type ModelDirectiveSelection, resolveModelDirectiveSelection } from "./model-selection.js";

function buildModelPickerCatalog(params: {
  cfg: ClawdbotConfig;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelCatalog: Array<{ provider: string; id?: string; name?: string }>;
}): ModelPickerCatalogEntry[] {
  const resolvedDefault = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });

  const keys = new Set<string>();
  const out: ModelPickerCatalogEntry[] = [];

  const push = (entry: ModelPickerCatalogEntry) => {
    const provider = normalizeProviderId(entry.provider);
    const id = String(entry.id ?? "").trim();
    if (!provider || !id) return;
    const key = modelKey(provider, id);
    if (keys.has(key)) return;
    keys.add(key);
    out.push({ provider, id, name: entry.name });
  };

  // Prefer catalog entries (when available), but always merge in config-only
  // allowlist entries. This keeps custom providers/models visible in /model.
  for (const entry of params.allowedModelCatalog) {
    push({
      provider: entry.provider,
      id: entry.id ?? "",
      name: entry.name,
    });
  }

  // Merge any configured allowlist keys that the catalog doesn't know about.
  for (const raw of Object.keys(params.cfg.agents?.defaults?.models ?? {})) {
    const resolved = resolveModelRefFromString({
      raw: String(raw),
      defaultProvider: params.defaultProvider,
      aliasIndex: params.aliasIndex,
    });
    if (!resolved) continue;
    push({
      provider: resolved.ref.provider,
      id: resolved.ref.model,
      name: resolved.ref.model,
    });
  }

  // Ensure the configured default is always present (even when no allowlist).
  if (resolvedDefault.model) {
    push({
      provider: resolvedDefault.provider,
      id: resolvedDefault.model,
      name: resolvedDefault.model,
    });
  }

  return out;
}

export async function maybeHandleModelDirectiveInfo(params: {
  directives: InlineDirectives;
  cfg: ClawdbotConfig;
  agentDir: string;
  activeAgentId: string;
  provider: string;
  model: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelCatalog: Array<{ provider: string; id?: string; name?: string }>;
  resetModelOverride: boolean;
}): Promise<ReplyPayload | undefined> {
  if (!params.directives.hasModelDirective) return undefined;

  const rawDirective = params.directives.rawModelDirective?.trim();
  const directive = rawDirective?.toLowerCase();
  const wantsStatus = directive === "status";
  const wantsList = !rawDirective || directive === "list";
  if (!wantsList && !wantsStatus) return undefined;

  if (params.directives.rawModelProfile) {
    return { text: "Auth profile override requires a model selection." };
  }

  const pickerCatalog = buildModelPickerCatalog({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    aliasIndex: params.aliasIndex,
    allowedModelCatalog: params.allowedModelCatalog,
  });

  if (wantsList) {
    const items = buildModelPickerItems(pickerCatalog);
    if (items.length === 0) return { text: "No models available." };
    const current = `${params.provider}/${params.model}`;
    const lines: string[] = [`Current: ${current}`, "Pick: /model <#> or /model <provider/model>"];
    for (const [idx, item] of items.entries()) {
      lines.push(`${idx + 1}) ${item.provider}/${item.model}`);
    }
    lines.push("", "More: /model status");
    return { text: lines.join("\n") };
  }

  const modelsPath = `${params.agentDir}/models.json`;
  const formatPath = (value: string) => shortenHomePath(value);
  const authMode: ModelAuthDetailMode = "verbose";
  if (pickerCatalog.length === 0) return { text: "No models available." };

  const authByProvider = new Map<string, string>();
  for (const entry of pickerCatalog) {
    const provider = normalizeProviderId(entry.provider);
    if (authByProvider.has(provider)) continue;
    const auth = await resolveAuthLabel(
      provider,
      params.cfg,
      modelsPath,
      params.agentDir,
      authMode,
    );
    authByProvider.set(provider, formatAuthLabel(auth));
  }

  const current = `${params.provider}/${params.model}`;
  const defaultLabel = `${params.defaultProvider}/${params.defaultModel}`;
  const lines = [
    `Current: ${current}`,
    `Default: ${defaultLabel}`,
    `Agent: ${params.activeAgentId}`,
    `Auth file: ${formatPath(resolveAuthStorePathForDisplay(params.agentDir))}`,
  ];
  if (params.resetModelOverride) {
    lines.push(`(previous selection reset to default)`);
  }

  const byProvider = new Map<string, ModelPickerCatalogEntry[]>();
  for (const entry of pickerCatalog) {
    const provider = normalizeProviderId(entry.provider);
    const models = byProvider.get(provider);
    if (models) {
      models.push(entry);
      continue;
    }
    byProvider.set(provider, [entry]);
  }

  for (const provider of byProvider.keys()) {
    const models = byProvider.get(provider);
    if (!models) continue;
    const authLabel = authByProvider.get(provider) ?? "missing";
    const endpoint = resolveProviderEndpointLabel(provider, params.cfg);
    const endpointSuffix = endpoint.endpoint
      ? ` endpoint: ${endpoint.endpoint}`
      : " endpoint: default";
    const apiSuffix = endpoint.api ? ` api: ${endpoint.api}` : "";
    lines.push("");
    lines.push(`[${provider}]${endpointSuffix}${apiSuffix} auth: ${authLabel}`);
    for (const entry of models) {
      const label = `${provider}/${entry.id}`;
      const aliases = params.aliasIndex.byKey.get(label);
      const aliasSuffix = aliases && aliases.length > 0 ? ` (${aliases.join(", ")})` : "";
      lines.push(`  • ${label}${aliasSuffix}`);
    }
  }
  return { text: lines.join("\n") };
}

export function resolveModelSelectionFromDirective(params: {
  directives: InlineDirectives;
  cfg: ClawdbotConfig;
  agentDir: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: Array<{ provider: string; id?: string; name?: string }>;
  provider: string;
}): {
  modelSelection?: ModelDirectiveSelection;
  profileOverride?: string;
  errorText?: string;
} {
  if (!params.directives.hasModelDirective || !params.directives.rawModelDirective) {
    if (params.directives.rawModelProfile) {
      return { errorText: "Auth profile override requires a model selection." };
    }
    return {};
  }

  const raw = params.directives.rawModelDirective.trim();
  let modelSelection: ModelDirectiveSelection | undefined;

  if (/^[0-9]+$/.test(raw)) {
    const pickerCatalog = buildModelPickerCatalog({
      cfg: params.cfg,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
      aliasIndex: params.aliasIndex,
      allowedModelCatalog: params.allowedModelCatalog,
    });
    const items = buildModelPickerItems(pickerCatalog);
    const index = Number.parseInt(raw, 10) - 1;
    const item = Number.isFinite(index) ? items[index] : undefined;
    if (!item) {
      return {
        errorText: `Invalid model selection "${raw}". Use /model to list.`,
      };
    }
    const key = `${item.provider}/${item.model}`;
    const aliases = params.aliasIndex.byKey.get(key);
    const alias = aliases && aliases.length > 0 ? aliases[0] : undefined;
    modelSelection = {
      provider: item.provider,
      model: item.model,
      isDefault: item.provider === params.defaultProvider && item.model === params.defaultModel,
      ...(alias ? { alias } : {}),
    };
  } else {
    const resolved = resolveModelDirectiveSelection({
      raw,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
      aliasIndex: params.aliasIndex,
      allowedModelKeys: params.allowedModelKeys,
    });
    if (resolved.error) {
      return { errorText: resolved.error };
    }
    modelSelection = resolved.selection;
  }

  let profileOverride: string | undefined;
  if (modelSelection && params.directives.rawModelProfile) {
    const profileResolved = resolveProfileOverride({
      rawProfile: params.directives.rawModelProfile,
      provider: modelSelection.provider,
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
    if (profileResolved.error) {
      return { errorText: profileResolved.error };
    }
    profileOverride = profileResolved.profileId;
  }

  return { modelSelection, profileOverride };
}
