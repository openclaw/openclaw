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
  const merged = mergeModelRefMapEntries(target, source, path).value as ModelProviderConfig;
  const models = new Map<string, ModelProviderConfig["models"][number]>();
  for (const model of [...(target.models ?? []), ...(source.models ?? [])]) {
    const existing = models.get(model.id);
    models.set(
      model.id,
      existing
        ? (mergeModelRefMapEntries(existing, model, `${path}.models.${model.id}`)
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
  const normalize = (agentId?: string) => (ref: string) => {
    const rewritten = rewriteProviderModelRef(ref, renames, agentId);
    if (
      rewritten !== undefined &&
      splitTrailingAuthProfile(ref).profile !== splitTrailingAuthProfile(rewritten).profile
    ) {
      changedAuthPin = true;
    }
    return rewritten ?? null;
  };
  const entries = config.agents?.entries;
  const globalConfig = entries
    ? { ...config, agents: { ...config.agents, entries: undefined } }
    : config;
  let rewritten = rewriteModelRefs(globalConfig, "config", changes, normalize())
    .value as OpenClawConfig;
  if (entries) {
    rewritten = {
      ...rewritten,
      agents: {
        ...rewritten.agents,
        entries: Object.fromEntries(
          Object.entries(entries).map(([agentId, entry]) => [
            agentId,
            rewriteModelRefs(entry, `config.agents.entries.${agentId}`, changes, normalize(agentId))
              .value as typeof entry,
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

export function rewriteRenamedSessionModelPair(
  entry: SessionEntry,
  providerKey: "modelProvider" | "providerOverride",
  modelKey: "model" | "modelOverride",
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
  const normalize = (ref: string) => rewriteProviderModelRef(ref, renames, agentId) ?? null;
  const scopedChanges: string[] = [];
  const pairChanges: string[] = [];
  const scoped = rewriteModelRefs(model, `${path}.model`, scopedChanges, normalize);
  const pair = rewriteModelRefs({ provider, model }, `${path}.${modelKey}`, pairChanges, normalize);
  if (!scoped.changed && !pair.changed) {
    return false;
  }
  const rewritten = pair.value as { provider?: string; model: string };
  if (pair.changed) {
    entry[providerKey] = rewritten.provider;
  }
  entry[modelKey] = scoped.changed ? (scoped.value as string) : rewritten.model;
  for (const change of scoped.changed ? scopedChanges : pairChanges) {
    changes?.add(
      scoped.changed && modelKey === "modelOverride"
        ? change.replace(`${path}.model `, `${path}.modelOverride `)
        : change,
    );
  }
  return true;
}
