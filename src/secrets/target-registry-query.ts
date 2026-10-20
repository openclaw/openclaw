import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { formatConcreteConfigPath, type ConcreteConfigPathSegment } from "../shared/dot-path.js";
import { loadChannelSecretContractApi } from "./channel-contract-api.js";
import { getPath } from "./path-utils.js";
import {
  buildSecretTargetRegistryFromPlugins,
  getCoreSecretTargetRegistry,
  getSecretTargetRegistry,
} from "./target-registry-data.js";
import {
  compileTargetRegistryEntry,
  expandPathTokens,
  materializePathTokens,
  matchPathTokens,
  type CompiledTargetRegistryEntry,
} from "./target-registry-pattern.js";
import type {
  DiscoveredConfigSecretTarget,
  ResolvedPlanTarget,
  SecretTargetConfigFile,
  SecretTargetRegistryEntry,
} from "./target-registry-types.js";

type CompiledSecretTargetRegistryState = ReturnType<typeof compileSecretTargetRegistryState>;

let compiledSecretTargetRegistryState: CompiledSecretTargetRegistryState | null = null;
let compiledCoreSecretTargetRegistryState: CompiledSecretTargetRegistryState | null = null;

// Channel contract entries are process-stable; plugin install/reload is the owner of freshness.
const compiledChannelOpenClawTargets = new Map<string, CompiledTargetRegistryEntry[] | null>();
const compiledPluginConfigTargets = new Map<string, CompiledTargetRegistryEntry[]>();
const compiledPluginConfigTargetsWithChannels = new Map<string, CompiledTargetRegistryEntry[]>();

function indexSecretTargets(
  entries: CompiledTargetRegistryEntry[],
  key: "id" | "targetType",
): Map<string, CompiledTargetRegistryEntry[]> {
  const index = new Map<string, CompiledTargetRegistryEntry[]>();
  for (const entry of entries) {
    const keys = [entry[key], ...(key === "targetType" ? (entry.targetTypeAliases ?? []) : [])];
    for (const value of keys) {
      const existing = index.get(value);
      if (existing) {
        existing.push(entry);
      } else {
        index.set(value, [entry]);
      }
    }
  }
  return index;
}

function compileSecretTargetRegistryState(registry: SecretTargetRegistryEntry[]) {
  const compiledSecretTargetRegistry = registry.map(compileTargetRegistryEntry);
  const openClawCompiledSecretTargets = compiledSecretTargetRegistry.filter(
    (entry) => entry.configFile === "openclaw.json",
  );
  const authProfilesCompiledSecretTargets = compiledSecretTargetRegistry.filter(
    (entry) => entry.configFile === "auth-profile-store",
  );
  return {
    authProfilesCompiledSecretTargets,
    authProfilesTargetsById: indexSecretTargets(authProfilesCompiledSecretTargets, "id"),
    compiledSecretTargetRegistry,
    knownTargetIds: new Set(compiledSecretTargetRegistry.map((entry) => entry.id)),
    openClawCompiledSecretTargets,
    openClawTargetsById: indexSecretTargets(openClawCompiledSecretTargets, "id"),
    targetsByType: indexSecretTargets(compiledSecretTargetRegistry, "targetType"),
  };
}

function getCompiledSecretTargetRegistryState() {
  if (compiledSecretTargetRegistryState) {
    return compiledSecretTargetRegistryState;
  }
  compiledSecretTargetRegistryState = compileSecretTargetRegistryState(getSecretTargetRegistry());
  return compiledSecretTargetRegistryState;
}

function getConfiguredSecretTargetRegistryState(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">,
) {
  return compileSecretTargetRegistryState(
    manifestRegistry
      ? buildSecretTargetRegistryFromPlugins(manifestRegistry.plugins, { config })
      : getSecretTargetRegistry({ config, env, configuredOnly: true }),
  );
}

function getCompiledCoreSecretTargetRegistryState() {
  compiledCoreSecretTargetRegistryState ??= compileSecretTargetRegistryState(
    getCoreSecretTargetRegistry(),
  );
  return compiledCoreSecretTargetRegistryState;
}

function getCompiledChannelOpenClawTargets(
  channelId: string,
): CompiledTargetRegistryEntry[] | null {
  const normalizedChannelId = channelId.trim();
  if (
    !normalizedChannelId ||
    normalizedChannelId === "." ||
    normalizedChannelId === ".." ||
    /[\\/:]/.test(normalizedChannelId)
  ) {
    return null;
  }
  if (compiledChannelOpenClawTargets.has(normalizedChannelId)) {
    return compiledChannelOpenClawTargets.get(normalizedChannelId) ?? null;
  }
  const compiledEntries =
    loadChannelSecretContractApi({
      channelId: normalizedChannelId,
      config: {} as OpenClawConfig,
      env: process.env,
    })
      ?.secretTargetRegistryEntries?.filter((entry) => entry.configFile === "openclaw.json")
      .map(compileTargetRegistryEntry) ?? null;
  compiledChannelOpenClawTargets.set(normalizedChannelId, compiledEntries);
  return compiledEntries;
}

function getPluginOwnedConfigPathEntries(
  pathTokens: readonly ConcreteConfigPathSegment[],
  broaderDiscovery = false,
): CompiledTargetRegistryEntry[] {
  // Config schema ownership is the boundary: core owns all roots except channels and
  // plugins.entries.<id>.config. Raw channel contracts are not constrained by their TS type,
  // but cannot extend core config schemas. Do not discover plugins to reject a core path.
  if (pathTokens[0] === "plugins") {
    const pluginId = pathTokens[2];
    if (
      pathTokens[1] !== "entries" ||
      typeof pluginId !== "string" ||
      !pluginId ||
      pathTokens[3] !== "config"
    ) {
      return [];
    }
    const cache = broaderDiscovery
      ? compiledPluginConfigTargetsWithChannels
      : compiledPluginConfigTargets;
    let entries = cache.get(pluginId);
    if (!entries) {
      entries = getSecretTargetRegistry({
        pluginConfig: { pluginIds: [pluginId], includeChannelContracts: broaderDiscovery },
      }).map(compileTargetRegistryEntry);
      cache.set(pluginId, entries);
    }
    return entries;
  }
  const channelId = pathTokens[0] === "channels" ? pathTokens[1] : undefined;
  if (typeof channelId !== "string" || !channelId) {
    return [];
  }
  // Any channel, including a bundled ID, can have additional external manifest owners.
  // Preserve the direct contract's precedence; a miss needs broader discovery.
  return broaderDiscovery
    ? getCompiledSecretTargetRegistryState().openClawCompiledSecretTargets.filter(
        (entry) =>
          entry.pathTokens[0]?.kind === "literal" && entry.pathTokens[0].value === "channels",
      )
    : (getCompiledChannelOpenClawTargets(channelId) ?? []);
}

function normalizeAllowedTargetIds(targetIds?: Iterable<string>): Set<string> | null {
  if (targetIds === undefined) {
    return null;
  }
  return new Set(
    Array.from(targetIds)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function configHasPluginEntries(config: OpenClawConfig): boolean {
  return Boolean(config.plugins?.entries && Object.keys(config.plugins.entries).length > 0);
}

function getConfiguredChannelOpenClawTargets(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): CompiledTargetRegistryEntry[] | null {
  const entries: CompiledTargetRegistryEntry[] = [];
  for (const channelId of Object.keys(config.channels ?? {})) {
    if (channelId === "defaults" || channelId === "modelByChannel" || channelId === "tools") {
      continue;
    }
    const contract = loadChannelSecretContractApi({
      channelId,
      config,
      env,
      bundledOnly: true,
    });
    if (!contract) {
      // External/custom channels may have multiple manifest owners. Only the full registry can
      // prove their target set is complete; a config-scoped first-contract lookup cannot.
      return null;
    }
    entries.push(
      ...(contract.secretTargetRegistryEntries
        ?.filter((entry) => entry.configFile === "openclaw.json")
        .map(compileTargetRegistryEntry) ?? []),
    );
  }
  return entries;
}

function resolveDiscoveryEntries(params: {
  allowedTargetIds: Set<string> | null;
  defaultEntries: CompiledTargetRegistryEntry[];
  entriesById: Map<string, CompiledTargetRegistryEntry[]>;
}): CompiledTargetRegistryEntry[] {
  if (params.allowedTargetIds === null) {
    return params.defaultEntries;
  }
  return Array.from(params.allowedTargetIds).flatMap(
    (targetId) => params.entriesById.get(targetId) ?? [],
  );
}

function discoverSecretTargetsFromEntries(
  source: unknown,
  discoveryEntries: CompiledTargetRegistryEntry[],
): DiscoveredConfigSecretTarget[] {
  const formatDiscoveredPath = (segments: readonly ConcreteConfigPathSegment[]) =>
    formatConcreteConfigPath(segments, source);
  const out: DiscoveredConfigSecretTarget[] = [];
  const seen = new Set<string>();

  for (const entry of discoveryEntries) {
    const expanded = expandPathTokens(source, entry.pathTokens);
    for (const match of expanded) {
      const resolved = toResolvedPlanTarget(entry, match.captures);
      if (!resolved) {
        continue;
      }
      const key = JSON.stringify([entry.id, ...resolved.pathTokens]);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const refValue = resolved.refPathSegments
        ? getPath(source, resolved.refPathSegments)
        : undefined;
      out.push({
        entry,
        path: formatDiscoveredPath(match.segments),
        pathSegments: resolved.pathSegments,
        ...(resolved.refPathSegments
          ? {
              refPathSegments: resolved.refPathSegments,
              refPath: formatDiscoveredPath(resolved.refPathTokens ?? resolved.refPathSegments),
            }
          : {}),
        value: match.value,
        ...(resolved.providerId ? { providerId: resolved.providerId } : {}),
        ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
        ...(resolved.refPathSegments ? { refValue } : {}),
      });
    }
  }

  return out;
}

function toResolvedPlanTarget(
  entry: CompiledTargetRegistryEntry,
  captures: ConcreteConfigPathSegment[],
): ResolvedPlanTarget | null {
  const pathTokens = materializePathTokens(entry.pathTokens, captures);
  if (!pathTokens) {
    return null;
  }
  const pathSegments = pathTokens.map(String);
  const providerId =
    entry.providerIdPathSegmentIndex !== undefined
      ? pathSegments[entry.providerIdPathSegmentIndex]
      : undefined;
  const accountId =
    entry.accountIdPathSegmentIndex !== undefined
      ? pathSegments[entry.accountIdPathSegmentIndex]
      : undefined;
  const refPathTokens = entry.refPathTokens
    ? materializePathTokens(entry.refPathTokens, captures)
    : undefined;
  if (entry.refPathTokens && !refPathTokens) {
    return null;
  }
  return {
    entry,
    pathSegments,
    pathTokens,
    ...(refPathTokens ? { refPathTokens, refPathSegments: refPathTokens.map(String) } : {}),
    ...(providerId ? { providerId } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

/** Lists all entries or a config path's candidate owners. */
export function listSecretTargetRegistryEntries(options?: {
  configPath: readonly ConcreteConfigPathSegment[];
}): SecretTargetRegistryEntry[] {
  const configPath = options?.configPath;
  const entries = configPath
    ? [
        ...getCompiledCoreSecretTargetRegistryState().openClawCompiledSecretTargets,
        ...getPluginOwnedConfigPathEntries(configPath, true),
      ]
    : getCompiledSecretTargetRegistryState().compiledSecretTargetRegistry;
  return entries.map((entry) =>
    Object.assign(
      { id: entry.id, targetType: entry.targetType },
      entry.targetTypeAliases ? { targetTypeAliases: [...entry.targetTypeAliases] } : {},
      { configFile: entry.configFile, pathPattern: entry.pathPattern },
      entry.pathPatternSegments ? { pathPatternSegments: [...entry.pathPatternSegments] } : {},
      entry.refPathPattern ? { refPathPattern: entry.refPathPattern } : {},
      {
        secretShape: entry.secretShape,
        expectedResolvedValue: entry.expectedResolvedValue,
        includeInPlan: entry.includeInPlan,
        includeInConfigure: entry.includeInConfigure,
        includeInAudit: entry.includeInAudit,
      },
      entry.providerIdPathSegmentIndex !== undefined
        ? { providerIdPathSegmentIndex: entry.providerIdPathSegmentIndex }
        : {},
      entry.accountIdPathSegmentIndex !== undefined
        ? { accountIdPathSegmentIndex: entry.accountIdPathSegmentIndex }
        : {},
      entry.authProfileType ? { authProfileType: entry.authProfileType } : {},
      entry.trackProviderShadowing ? { trackProviderShadowing: true } : {},
    ),
  );
}

export function isKnownSecretTargetId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (getCompiledCoreSecretTargetRegistryState().knownTargetIds.has(value)) {
    return true;
  }
  for (const entries of [
    ...compiledPluginConfigTargets.values(),
    ...compiledPluginConfigTargetsWithChannels.values(),
  ]) {
    if (entries.some((entry) => entry.id === value)) {
      return true;
    }
  }
  return getCompiledSecretTargetRegistryState().knownTargetIds.has(value);
}

/** Checks the static core registry without materializing plugin/channel contracts. */
export function isKnownCoreSecretTargetId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    getCompiledCoreSecretTargetRegistryState().knownTargetIds.has(value)
  );
}

export function resolvePlanTargetAgainstRegistry(candidate: {
  type: string;
  pathSegments: string[];
  pathTokens?: readonly ConcreteConfigPathSegment[];
  allowLegacyArrayString?: boolean;
  providerId?: string;
  accountId?: string;
}): ResolvedPlanTarget | null {
  const coreEntries = getCompiledCoreSecretTargetRegistryState().targetsByType.get(candidate.type);
  if (coreEntries) {
    return resolvePlanTargetAgainstEntries(candidate, coreEntries);
  }
  const explicitChannelId =
    candidate.pathSegments[0] === "channels" ? (candidate.pathSegments[1]?.trim() ?? "") : "";
  if (explicitChannelId && /[\\/:]/.test(explicitChannelId)) {
    return null;
  }
  const pathTokens = candidate.pathTokens ?? candidate.pathSegments;
  const directEntries = indexSecretTargets(
    getPluginOwnedConfigPathEntries(pathTokens),
    "targetType",
  ).get(candidate.type);
  const directTarget = resolvePlanTargetAgainstEntries(candidate, directEntries);
  if (directTarget) {
    return directTarget;
  }
  const entries = indexSecretTargets(
    getPluginOwnedConfigPathEntries(pathTokens, true),
    "targetType",
  ).get(candidate.type);
  return resolvePlanTargetAgainstEntries(candidate, entries);
}

function resolvePlanTargetAgainstEntries(
  candidate: {
    pathSegments: string[];
    pathTokens?: readonly ConcreteConfigPathSegment[];
    allowLegacyArrayString?: boolean;
    providerId?: string;
    accountId?: string;
  },
  entries: CompiledTargetRegistryEntry[] | undefined,
): ResolvedPlanTarget | null {
  if (!entries || entries.length === 0) {
    return null;
  }

  const pathTokens = candidate.pathTokens ?? candidate.pathSegments;
  for (const entry of entries) {
    if (!entry.includeInPlan) {
      continue;
    }
    const matched = matchPathTokens(pathTokens, entry.pathTokens, {
      allowLegacyArrayString: candidate.allowLegacyArrayString,
    });
    if (!matched) {
      continue;
    }
    const resolved = toResolvedPlanTarget(entry, matched.captures);
    if (!resolved) {
      continue;
    }
    if (candidate.providerId && candidate.providerId.trim().length > 0) {
      if (!resolved.providerId || resolved.providerId !== candidate.providerId) {
        continue;
      }
    }
    if (candidate.accountId && candidate.accountId.trim().length > 0) {
      if (!resolved.accountId || resolved.accountId !== candidate.accountId) {
        continue;
      }
    }
    return resolved;
  }
  return null;
}

/**
 * Resolves a plan-capable secret target by owning config document and concrete path.
 */
export function resolveSecretPlanTargetByPathCore(params: {
  configFile: SecretTargetConfigFile;
  pathSegments: string[];
  pathTokens?: readonly ConcreteConfigPathSegment[];
}): ResolvedPlanTarget | null {
  if (params.configFile === "openclaw.json") {
    return resolveConfigSecretTargetByPath(params.pathSegments, params.pathTokens);
  }
  return resolvePlanTargetAgainstEntries(
    { pathSegments: params.pathSegments, pathTokens: params.pathTokens },
    getCompiledCoreSecretTargetRegistryState().authProfilesCompiledSecretTargets,
  );
}

export function resolveConfigSecretTargetByPath(
  pathSegments: string[],
  pathTokens: readonly ConcreteConfigPathSegment[] = pathSegments,
): ResolvedPlanTarget | null {
  const candidate = { pathSegments, pathTokens };
  const coreTarget = resolvePlanTargetAgainstEntries(
    candidate,
    getCompiledCoreSecretTargetRegistryState().openClawCompiledSecretTargets,
  );
  if (coreTarget) {
    return coreTarget;
  }

  return (
    resolvePlanTargetAgainstEntries(candidate, getPluginOwnedConfigPathEntries(pathTokens)) ??
    resolvePlanTargetAgainstEntries(candidate, getPluginOwnedConfigPathEntries(pathTokens, true))
  );
}

export function discoverConfigSecretTargets(
  config: OpenClawConfig,
  options: {
    env?: NodeJS.ProcessEnv;
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  } = {},
): DiscoveredConfigSecretTarget[] {
  return discoverConfigSecretTargetsByIds(config, undefined, options);
}

export function discoverConfigSecretTargetsByIds(
  config: OpenClawConfig,
  targetIds?: Iterable<string>,
  options: {
    env?: NodeJS.ProcessEnv;
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  } = {},
): DiscoveredConfigSecretTarget[] {
  const env = options.env ?? process.env;
  const allowedTargetIds = normalizeAllowedTargetIds(targetIds);
  const coreState = getCompiledCoreSecretTargetRegistryState();
  const hasPluginEntries = configHasPluginEntries(config);
  // Absent plugin-owned subtrees cannot contribute targets, even for unknown requested IDs.
  const canUseCoreTargets =
    (!hasPluginEntries && Object.keys(config.channels ?? {}).length === 0) ||
    (allowedTargetIds !== null &&
      Array.from(allowedTargetIds).every((targetId) => coreState.knownTargetIds.has(targetId)));
  const configuredChannelEntries =
    !options.manifestRegistry && !canUseCoreTargets && !hasPluginEntries
      ? getConfiguredChannelOpenClawTargets(config, env)
      : null;
  const configuredEntries = canUseCoreTargets
    ? coreState.openClawCompiledSecretTargets
    : configuredChannelEntries
      ? [...coreState.openClawCompiledSecretTargets, ...configuredChannelEntries]
      : null;
  const configuredEntriesById = configuredEntries
    ? indexSecretTargets(configuredEntries, "id")
    : null;
  const canUseConfiguredEntries =
    configuredEntries !== null &&
    (canUseCoreTargets ||
      allowedTargetIds === null ||
      Array.from(allowedTargetIds).every((targetId) => configuredEntriesById?.has(targetId)));
  const registryState = canUseConfiguredEntries
    ? null
    : getConfiguredSecretTargetRegistryState(config, env, options.manifestRegistry);
  const discoveryEntries = resolveDiscoveryEntries({
    allowedTargetIds,
    defaultEntries: registryState?.openClawCompiledSecretTargets ?? configuredEntries ?? [],
    entriesById: registryState?.openClawTargetsById ?? configuredEntriesById ?? new Map(),
  });
  return discoverSecretTargetsFromEntries(config, discoveryEntries);
}

export function discoverAuthProfileSecretTargets(
  store: unknown,
  targetIds?: Iterable<string>,
): DiscoveredConfigSecretTarget[] {
  const allowedTargetIds = normalizeAllowedTargetIds(targetIds);
  const registryState = getCompiledCoreSecretTargetRegistryState();
  const discoveryEntries = resolveDiscoveryEntries({
    allowedTargetIds,
    defaultEntries: registryState.authProfilesCompiledSecretTargets,
    entriesById: registryState.authProfilesTargetsById,
  });
  return discoverSecretTargetsFromEntries(store, discoveryEntries);
}

export type { DiscoveredConfigSecretTarget, ResolvedPlanTarget } from "./target-registry-types.js";
