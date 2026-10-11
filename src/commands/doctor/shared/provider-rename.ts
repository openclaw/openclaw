import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type { ModelProviderConfig } from "../../../config/types.models.js";
import type { PluginDoctorProviderRename } from "../../../plugins/doctor-contract-module.js";
import {
  mergeModelRefMapEntries,
  rewriteModelRefs,
} from "./legacy-config-migrations.runtime.models.refs.js";

export type ProviderRenameAuthProfiles = {
  targetAuthProfileIds: readonly string[];
  targetAuthProfileId?: string;
};

export type ProviderRename = PluginDoctorProviderRename & {
  targetAuthProfileIds?: readonly string[];
  targetAuthProfileId?: string;
  targetAuthProfilesByAgent?: Readonly<Record<string, ProviderRenameAuthProfiles>>;
  sharedAuthProfiles?: ProviderRenameAuthProfiles;
};

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
  agentId?: string,
): string | undefined {
  const parsed = splitTrailingAuthProfile(ref);
  const rename = renames.find(({ from }) => parsed.model.startsWith(`${from}/`));
  if (!rename) {
    return undefined;
  }
  const model = `${rename.to}${parsed.model.slice(rename.from.length)}`;
  if (!parsed.profile) {
    return model;
  }
  const auth = agentId
    ? (rename.targetAuthProfilesByAgent?.[agentId] ?? rename.sharedAuthProfiles ?? rename)
    : rename;
  const profile = auth.targetAuthProfileIds?.includes(parsed.profile)
    ? parsed.profile
    : auth.targetAuthProfileId;
  return profile ? `${model}@${profile}` : model;
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
  let changedAuthPin = false;
  const normalize =
    (scopedRenames: readonly ProviderRename[], agentId?: string) => (ref: string) => {
      const rewritten = rewriteProviderModelRef(ref, scopedRenames, agentId);
      if (
        rewritten !== undefined &&
        splitTrailingAuthProfile(ref).profile !== splitTrailingAuthProfile(rewritten).profile
      ) {
        changedAuthPin = true;
      }
      return rewritten ?? null;
    };
  // Inherited references must remain usable by every agent, not just the system agent.
  const globalRenames = renames.map((rename) =>
    rename.sharedAuthProfiles ? { ...rename, ...rename.sharedAuthProfiles } : rename,
  );
  const entries = config.agents?.entries;
  const globalConfig = entries
    ? { ...config, agents: { ...config.agents, entries: undefined } }
    : config;
  let rewritten = rewriteModelRefs(globalConfig, "config", changes, normalize(globalRenames))
    // SAFETY: The walker preserves the config shape, changing only model-reference strings and map keys.
    .value as OpenClawConfig;
  if (entries) {
    rewritten = {
      ...rewritten,
      agents: {
        ...rewritten.agents,
        entries: Object.fromEntries(
          Object.entries(entries).map(([agentId, entry]) => [
            agentId,
            rewriteModelRefs(
              entry,
              `config.agents.entries.${agentId}`,
              changes,
              normalize(renames, agentId),
              // SAFETY: The walker preserves this typed agent entry's fields while rewriting model references.
            ).value as typeof entry,
          ]),
        ),
      },
    };
  }
  if (changedAuthPin) {
    changes.push(
      "Provider migration updated auth profile pins; to choose another saved account, re-pin the model with /model <provider/model>@<profile>.",
    );
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
  path: string,
  changes?: Set<string>,
  agentId?: string,
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
  const scopedModel = rewriteProviderModelRef(model, renames, agentId);
  const pairChanges: string[] = [];
  const pair = rewriteModelRefs(
    { provider, model },
    `${path}.${modelKey}`,
    pairChanges,
    (ref) => rewriteProviderModelRef(ref, renames, agentId) ?? null,
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
  if (scopedModel !== undefined) {
    changes?.add(
      `Upgraded ${path}.${modelKey} from ${JSON.stringify(model)} to ${JSON.stringify(scopedModel)}.`,
    );
  } else {
    for (const change of pairChanges) {
      changes?.add(change);
    }
  }
  return true;
}

export function rewriteRenamedSessionRoutes(params: {
  entry: SessionEntry;
  renames: readonly ProviderRename[];
  path: string;
  changes?: Set<string>;
  agentId?: string;
}): boolean {
  let changed = false;
  for (const [providerKey, modelKey] of [
    ["modelProvider", "model"],
    ["providerOverride", "modelOverride"],
    ["modelOverrideFallbackOriginProvider", "modelOverrideFallbackOriginModel"],
  ] as const) {
    changed =
      rewriteRenamedSessionModelPair(
        params.entry,
        providerKey,
        modelKey,
        params.renames,
        params.path,
        params.changes,
        params.agentId,
      ) || changed;
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
          `${params.path}.modelFallback`,
          params.changes,
          params.agentId,
        ) || changed;
    }
  }
  return changed;
}
