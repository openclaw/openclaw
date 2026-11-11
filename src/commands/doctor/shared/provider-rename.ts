import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import { getRecord } from "../../../config/legacy.shared.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type { ModelProviderConfig } from "../../../config/types.models.js";
import type { PluginDoctorProviderRename } from "../../../plugins/doctor-contract-module.js";
import {
  mergeModelRefMapEntries,
  rewriteModelRefs,
} from "./legacy-config-migrations.runtime.models.refs.js";

export type ProviderRename = PluginDoctorProviderRename;

function urlOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

export function planProviderRenames(
  config: OpenClawConfig,
  declarations: readonly ProviderRename[],
): ProviderRename[] {
  return declarations.filter(({ from, baseUrl }) => {
    const provider = config.models?.providers?.[from];
    const origin = typeof provider?.baseUrl === "string" ? urlOrigin(provider.baseUrl) : undefined;
    return origin !== undefined && origin === urlOrigin(baseUrl);
  });
}

export function rewriteProviderModelRef(
  ref: string,
  renames: readonly ProviderRename[],
): string | undefined {
  const parsed = splitTrailingAuthProfile(ref);
  const rename = renames.find(({ from }) => parsed.model.startsWith(`${from}/`));
  if (!rename) {
    return undefined;
  }
  return `${rename.to}${parsed.model.slice(rename.from.length)}`;
}

function mergeProviders(
  source: ModelProviderConfig,
  target: ModelProviderConfig,
  path: string,
): ModelProviderConfig {
  // SAFETY: Both inputs are provider configs; the merge retains target fields and fills missing source fields.
  const merged = mergeModelRefMapEntries(target, source, path).value as ModelProviderConfig;
  const models = new Map<string, ModelProviderConfig["models"][number]>();
  for (const model of [...(target.models ?? []), ...(source.models ?? [])]) {
    const existing = models.get(model.id);
    models.set(
      model.id,
      existing
        ? (mergeModelRefMapEntries(existing, model, `${path}.models.${model.id}`)
            // SAFETY: Both catalog entries have the same model ID and retain the target's required fields.
            .value as ModelProviderConfig["models"][number])
        : model,
    );
  }
  return { ...merged, models: [...models.values()] };
}

export function applyProviderRenames(
  config: OpenClawConfig,
  renames: readonly ProviderRename[],
): { config: OpenClawConfig; changes: string[] } {
  if (renames.length === 0) {
    return { config, changes: [] };
  }
  const changes: string[] = [];
  const memoryDefaults = config.memory?.search;
  const agentEntries = Object.entries(config.agents?.entries ?? {});
  const inheritedBaseUrls = new Map<object, string | undefined>();
  for (const [, agent] of agentEntries) {
    const search = agent.memory?.search;
    if (search) {
      inheritedBaseUrls.set(search, search.remote?.baseUrl ?? memoryDefaults?.remote?.baseUrl);
    }
  }
  const normalize = (ref: string, pair?: Record<string, unknown>) => {
    const baseUrl =
      pair && inheritedBaseUrls.has(pair)
        ? inheritedBaseUrls.get(pair)
        : getRecord(pair?.remote)?.baseUrl;
    const rename = renames.find(({ from }) => ref.startsWith(`${from}/`));
    // An explicit endpoint owns this route independently of the chat provider.
    if (
      rename &&
      typeof baseUrl === "string" &&
      baseUrl.trim() &&
      urlOrigin(baseUrl) !== urlOrigin(rename.baseUrl)
    ) {
      return null;
    }
    return rewriteProviderModelRef(ref, renames) ?? null;
  };
  let rewritten = rewriteModelRefs(config, "config", changes, normalize)
    // SAFETY: The walker preserves the config shape, changing only model-reference strings and map keys.
    .value as OpenClawConfig;
  let updatedEntries: NonNullable<OpenClawConfig["agents"]>["entries"];
  // Partial overrides have no provider/model pair for the walker. Pin only fields
  // whose effective route would otherwise change when the shared defaults migrate.
  for (const [agentId, agent] of agentEntries) {
    const search = agent.memory?.search;
    const provider = search?.provider ?? memoryDefaults?.provider;
    const model = search?.model ?? memoryDefaults?.model;
    if (!search || !provider || typeof model !== "string") {
      continue;
    }
    const ref = `${provider}/${model}`;
    const targetRef = normalize(ref, { remote: { baseUrl: inheritedBaseUrls.get(search) } }) ?? ref;
    const slash = targetRef.indexOf("/");
    const targetProvider = targetRef.slice(0, slash);
    const targetModel = targetRef.slice(slash + 1);
    const currentAgent = rewritten.agents?.entries?.[agentId];
    const current = currentAgent?.memory?.search;
    const providerChanged =
      (current?.provider ?? rewritten.memory?.search?.provider) !== targetProvider;
    const modelChanged = (current?.model ?? rewritten.memory?.search?.model) !== targetModel;
    if (!providerChanged && !modelChanged) {
      continue;
    }
    updatedEntries ??= { ...rewritten.agents?.entries };
    updatedEntries[agentId] = {
      ...currentAgent,
      memory: {
        ...currentAgent?.memory,
        search: {
          ...current,
          ...(providerChanged ? { provider: targetProvider } : {}),
          ...(modelChanged ? { model: targetModel } : {}),
        },
      },
    };
    changes.push(
      `Updated agents.entries.${agentId}.memory.search provider/model to ${JSON.stringify(targetRef)} after resolving inherited memory settings.`,
    );
  }
  if (updatedEntries) {
    rewritten = { ...rewritten, agents: { ...rewritten.agents, entries: updatedEntries } };
  }
  const providers = { ...rewritten.models?.providers };
  let moved = false;
  for (const { from, to } of renames) {
    const source = providers[from];
    if (!source) {
      continue;
    }
    providers[to] = providers[to]
      ? mergeProviders(source, providers[to], `models.providers.${to}`)
      : source;
    delete providers[from];
    moved = true;
    changes.push(`Migrated models.providers.${from} to models.providers.${to}.`);
  }
  if (moved) {
    changes.push(
      "Migrated model references no longer pin saved accounts. Re-pin with /model <provider/model>@<profile> to choose a saved account.",
    );
  }
  return {
    config: moved ? { ...rewritten, models: { ...rewritten.models, providers } } : rewritten,
    changes,
  };
}

function rewriteRenamedSessionModelPair<ProviderKey extends string, ModelKey extends string>(
  entry: Partial<Record<ProviderKey | ModelKey, string>>,
  providerKey: ProviderKey,
  modelKey: ModelKey,
  renames: readonly ProviderRename[],
): boolean {
  const provider = entry[providerKey];
  const model = entry[modelKey];
  if (typeof model !== "string") {
    return false;
  }
  // A different explicit provider owns slash-containing model IDs as raw IDs.
  if (provider && !renames.some((rename) => rename.from === provider)) {
    return false;
  }
  const scopedModel = rewriteProviderModelRef(model, renames);
  const pair = rewriteModelRefs(
    { provider, model },
    modelKey,
    [],
    (ref) => rewriteProviderModelRef(ref, renames) ?? null,
  );
  if (scopedModel === undefined && !pair.changed) {
    return false;
  }
  // SAFETY: The walker preserves the provider/model pair and only replaces its string values.
  const rewritten = pair.value as { provider?: string; model: string };
  if (pair.changed) {
    entry[providerKey] = rewritten.provider;
  }
  entry[modelKey] = scopedModel ?? rewritten.model;
  return true;
}

export function rewriteRenamedSessionRoutes(params: {
  entry: SessionEntry;
  renames: readonly ProviderRename[];
}): boolean {
  let changed = false;
  for (const [providerKey, modelKey] of [
    ["modelProvider", "model"],
    ["providerOverride", "modelOverride"],
    ["modelOverrideFallbackOriginProvider", "modelOverrideFallbackOriginModel"],
  ] as const) {
    changed =
      rewriteRenamedSessionModelPair(params.entry, providerKey, modelKey, params.renames) ||
      changed;
  }
  if (params.entry.modelFallback) {
    for (const [providerKey, modelKey] of [
      ["prevProvider", "prevModel"],
      ["prevProviderOverride", "prevModelOverride"],
      ["prevModelOverrideFallbackOriginProvider", "prevModelOverrideFallbackOriginModel"],
    ] as const) {
      changed =
        rewriteRenamedSessionModelPair(
          params.entry.modelFallback,
          providerKey,
          modelKey,
          params.renames,
        ) || changed;
    }
  }
  return changed;
}
