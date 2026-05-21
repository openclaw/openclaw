import type {
  PluginManifestAuthRequirement,
  PluginManifestProviderAuthChoice,
  PluginManifestSetup,
} from "./manifest.js";

export type PluginAuthRequirementSource =
  | "manifest"
  | "setup-provider"
  | "provider-auth-choice"
  | "provider-env-vars"
  | "channel-env-vars";

export type PluginAuthRequirementCarrier = {
  id: string;
  authRequirements?: readonly PluginManifestAuthRequirement[];
  setup?: PluginManifestSetup;
  providerAuthChoices?: readonly PluginManifestProviderAuthChoice[];
  providerAuthEnvVars?: Readonly<Record<string, readonly string[]>>;
  channelEnvVars?: Readonly<Record<string, readonly string[]>>;
};

export type PluginAuthRequirementPlanItem = {
  pluginId: string;
  source: PluginAuthRequirementSource;
  requirement: PluginManifestAuthRequirement;
};

export type PluginAuthRequirementCollectionOptions = {
  includeDerived?: boolean;
};

function normalizeStringList(values: readonly string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

function cloneRequirement(
  requirement: PluginManifestAuthRequirement,
): PluginManifestAuthRequirement {
  return {
    ...requirement,
    ...(requirement.authMethods ? { authMethods: [...requirement.authMethods] } : {}),
    ...(requirement.scopes ? { scopes: [...requirement.scopes] } : {}),
    ...(requirement.envVars ? { envVars: [...requirement.envVars] } : {}),
    ...(requirement.configPaths ? { configPaths: [...requirement.configPaths] } : {}),
    ...(requirement.secretRefs ? { secretRefs: [...requirement.secretRefs] } : {}),
    ...(requirement.setupRefs ? { setupRefs: [...requirement.setupRefs] } : {}),
  };
}

function toSortedEntries(
  values: Readonly<Record<string, readonly string[]>> | undefined,
): Array<[string, string[]]> {
  return Object.entries(values ?? {})
    .map(([id, list]): [string, string[]] => [id.trim(), normalizeStringList(list)])
    .filter(([id, list]) => id.length > 0 && list.length > 0)
    .toSorted(([left], [right]) => left.localeCompare(right));
}

/**
 * Returns the manifest-declared auth requirements plus compatibility hints
 * derived from existing manifest metadata. This is intentionally control-plane
 * only: it does not read secrets, validate credentials, or load plugin runtime.
 */
export function collectPluginAuthRequirements(
  plugin: PluginAuthRequirementCarrier,
  options: PluginAuthRequirementCollectionOptions = {},
): PluginAuthRequirementPlanItem[] {
  const includeDerived = options.includeDerived !== false;
  const collected: PluginAuthRequirementPlanItem[] = [];
  const seenRequirementIds = new Set<string>();
  const setupProviderIds = new Set<string>();

  const pushRequirement = (
    source: PluginAuthRequirementSource,
    requirement: PluginManifestAuthRequirement,
  ) => {
    if (!requirement.id || seenRequirementIds.has(requirement.id)) {
      return;
    }
    seenRequirementIds.add(requirement.id);
    collected.push({
      pluginId: plugin.id,
      source,
      requirement: cloneRequirement(requirement),
    });
  };

  for (const requirement of plugin.authRequirements ?? []) {
    pushRequirement("manifest", requirement);
  }

  if (!includeDerived) {
    return collected;
  }

  const providerEnvVarEntries = toSortedEntries(plugin.providerAuthEnvVars);
  const providerEnvVarsById = new Map(providerEnvVarEntries);

  for (const provider of plugin.setup?.providers ?? []) {
    const authMethods = normalizeStringList(provider.authMethods);
    const legacyEnvVars = providerEnvVarsById.get(provider.id) ?? [];
    const envVars = normalizeStringList([...(provider.envVars ?? []), ...legacyEnvVars]);
    const setupRefs = [`setup.providers:${provider.id}`];
    if (legacyEnvVars.length > 0) {
      setupRefs.push(`providerAuthEnvVars:${provider.id}`);
    }
    setupProviderIds.add(provider.id);
    pushRequirement("setup-provider", {
      id: `provider:${provider.id}`,
      kind: "provider",
      provider: provider.id,
      setupRefs,
      ...(authMethods.length > 0 ? { authMethods } : {}),
      ...(envVars.length > 0 ? { envVars } : {}),
    });
  }

  for (const choice of plugin.providerAuthChoices ?? []) {
    const scopes = normalizeStringList(choice.onboardingScopes);
    pushRequirement("provider-auth-choice", {
      id: `provider-auth-choice:${choice.choiceId}`,
      kind: "provider",
      provider: choice.provider,
      authMethods: [choice.method],
      setupRefs: [`providerAuthChoices:${choice.choiceId}`],
      ...(scopes.length > 0 ? { scopes } : {}),
    });
  }

  for (const [provider, envVars] of providerEnvVarEntries) {
    if (setupProviderIds.has(provider)) {
      continue;
    }
    pushRequirement("provider-env-vars", {
      id: `provider-env:${provider}`,
      kind: "provider",
      provider,
      envVars,
      setupRefs: [`providerAuthEnvVars:${provider}`],
    });
  }

  for (const [channel, envVars] of toSortedEntries(plugin.channelEnvVars)) {
    pushRequirement("channel-env-vars", {
      id: `channel:${channel}`,
      kind: "channel-account",
      channel,
      envVars,
      setupRefs: [`channelEnvVars:${channel}`],
    });
  }

  return collected;
}
