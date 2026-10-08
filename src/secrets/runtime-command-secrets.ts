/** Resolves command-scoped secrets, including web provider override credentials. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { cloneConfigWithResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseSecretRef } from "../config/types.secrets.js";
import { resolveManifestContractOwnerPluginId } from "../plugins/plugin-registry.js";
import {
  analyzeCommandSecretAssignmentsFromSnapshot,
  type CommandSecretAssignment,
} from "./command-config.js";
import { setPathExistingStrict } from "./path-utils.js";
import { resolveSecretRefValue } from "./resolve.js";
import { createResolverContext } from "./runtime-shared.js";
import {
  getActiveSecretsRuntimeEnvState,
  getActiveSecretsRuntimeSnapshotState,
} from "./runtime-state.js";
import { resolveRuntimeWebTools } from "./runtime-web-tools.js";
import { assertExpectedResolvedSecretValue } from "./secret-value.js";
import { discoverConfigSecretTargetsByIds } from "./target-registry.js";

export type { CommandSecretAssignment } from "./command-config.js";

/** Provider selections applied only while resolving command-scoped web secrets. */
type CommandSecretProviderOverrides = {
  /** Temporary web-search provider id for this command request. */
  webSearch?: string;
  /** Temporary web-fetch provider id for this command request. */
  webFetch?: string;
};

function hasProviderOverrides(overrides: CommandSecretProviderOverrides | undefined): boolean {
  return (
    normalizeOptionalString(overrides?.webSearch) !== undefined ||
    normalizeOptionalString(overrides?.webFetch) !== undefined
  );
}

function applyProviderOverridesToConfig(
  config: OpenClawConfig,
  overrides: CommandSecretProviderOverrides | undefined,
): OpenClawConfig {
  if (!hasProviderOverrides(overrides)) {
    return config;
  }
  const next = cloneConfigWithResolutionFacts(config);
  const tools = (next.tools ??= {}) as Record<string, unknown>;
  const web = (tools.web ??= {}) as Record<string, unknown>;
  const webSearch = normalizeOptionalString(overrides?.webSearch);
  if (webSearch) {
    const search = (web.search ??= {}) as Record<string, unknown>;
    search.provider = webSearch;
  }
  const webFetch = normalizeOptionalString(overrides?.webFetch);
  if (webFetch) {
    const fetch = (web.fetch ??= {}) as Record<string, unknown>;
    fetch.provider = webFetch;
  }
  return next;
}

function pluginIdFromRuntimeWebPath(path: string): string | undefined {
  return /^plugins\.entries\.([^.]+)\.config\.(webSearch|webFetch)\.apiKey$/.exec(path)?.[1];
}

function isProviderOverridePath(params: {
  config: OpenClawConfig;
  path: string;
  providerOverrides: CommandSecretProviderOverrides | undefined;
}): boolean {
  for (const [overrideKey, kind, contract] of [
    ["webSearch", "search", "webSearchProviders"],
    ["webFetch", "fetch", "webFetchProviders"],
  ] as const) {
    const provider = normalizeOptionalString(params.providerOverrides?.[overrideKey]);
    if (!provider) {
      continue;
    }
    if (params.config.tools?.web?.[kind]?.enabled === false) {
      return false;
    }
    const pluginId = pluginIdFromRuntimeWebPath(params.path);
    if (pluginId && params.path.endsWith(`.config.${overrideKey}.apiKey`)) {
      return (
        resolveManifestContractOwnerPluginId({
          contract,
          value: provider,
          origin: "bundled",
          config: params.config,
        }) === pluginId
      );
    }
  }

  return false;
}

function restoreInactiveWebCommandSecretTargets(params: {
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  targetIds: ReadonlySet<string>;
  inactiveRefPaths: string[];
  isInactivePath: (path: string) => boolean;
}): string[] {
  const inactive = new Set(params.inactiveRefPaths);
  const defaults = params.sourceConfig.secrets?.defaults;
  for (const target of discoverConfigSecretTargetsByIds(params.sourceConfig, params.targetIds)) {
    if (!pluginIdFromRuntimeWebPath(target.path)) {
      continue;
    }
    // Provider overrides can make a web SecretRef active for this command only. Other web refs
    // must be restored from source config so assignment analysis keeps them inactive.
    const ref = parseSecretRef(target.refValue, defaults) ?? parseSecretRef(target.value, defaults);
    if (!ref) {
      continue;
    }
    if (!params.isInactivePath(target.path)) {
      continue;
    }
    inactive.add(target.path);
    setPathExistingStrict(params.resolvedConfig, target.pathSegments, target.value);
  }
  return [...inactive];
}

async function resolveForcedActiveCommandSecretTargets(params: {
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  targetIds: ReadonlySet<string>;
  allowedPaths?: ReadonlySet<string>;
  forcedActivePaths?: ReadonlySet<string>;
  optionalActivePaths?: ReadonlySet<string>;
}): Promise<void> {
  const activePaths = new Set([
    ...(params.forcedActivePaths ?? []),
    ...(params.optionalActivePaths ?? []),
  ]);
  if (activePaths.size === 0) {
    return;
  }
  const context = createResolverContext({
    sourceConfig: params.sourceConfig,
    env: getActiveSecretsRuntimeEnvState(),
  });
  const defaults = params.sourceConfig.secrets?.defaults;
  for (const target of discoverConfigSecretTargetsByIds(params.sourceConfig, params.targetIds)) {
    if (params.allowedPaths && !params.allowedPaths.has(target.path)) {
      continue;
    }
    if (!activePaths.has(target.path)) {
      continue;
    }
    const ref = parseSecretRef(target.refValue, defaults) ?? parseSecretRef(target.value, defaults);
    if (!ref) {
      continue;
    }
    try {
      const resolved = await resolveSecretRefValue(ref, {
        config: params.sourceConfig,
        env: context.env,
        cache: context.cache,
      });
      assertExpectedResolvedSecretValue({
        value: resolved,
        expected: target.entry.expectedResolvedValue,
        errorMessage:
          target.entry.expectedResolvedValue === "string"
            ? `${target.path} resolved to a non-string or empty value.`
            : `${target.path} resolved to an unsupported value type.`,
      });
      setPathExistingStrict(params.resolvedConfig, target.pathSegments, resolved);
    } catch {
      // Leave unresolved; the CLI can still attempt local fallback for incomplete gateway snapshots.
    }
  }
}

/**
 * Resolves command-scoped SecretRef assignments from the active runtime snapshot.
 * Provider overrides are evaluated against cloned snapshot config.
 */
export function resolveCommandSecretsFromActiveRuntimeSnapshot(params: {
  /** Command name used in diagnostics returned to gateway/tool callers. */
  commandName: string;
  /** Secret target registry ids the command is allowed to resolve. */
  targetIds: ReadonlySet<string>;
  /** Optional exact config paths allowed inside `targetIds`. */
  allowedPaths?: ReadonlySet<string>;
  /** Inactive paths to force active because command-local provider overrides select them. */
  forcedActivePaths?: ReadonlySet<string>;
  /** Inactive paths that may stay unresolved without diagnostics. */
  optionalActivePaths?: ReadonlySet<string>;
  providerOverrides?: CommandSecretProviderOverrides;
}): Promise<{
  assignments: CommandSecretAssignment[];
  diagnostics: string[];
  inactiveRefPaths: string[];
}> {
  const activeSnapshot = getActiveSecretsRuntimeSnapshotState();
  if (!activeSnapshot) {
    throw new Error("Secrets runtime snapshot is not active.");
  }
  if (params.targetIds.size === 0) {
    return Promise.resolve({ assignments: [], diagnostics: [], inactiveRefPaths: [] });
  }
  return resolveCommandSecretsFromSnapshot(activeSnapshot, { ...params });
}

async function resolveCommandSecretsFromSnapshot(
  activeSnapshot: NonNullable<ReturnType<typeof getActiveSecretsRuntimeSnapshotState>>,
  params: Parameters<typeof resolveCommandSecretsFromActiveRuntimeSnapshot>[0],
): ReturnType<typeof resolveCommandSecretsFromActiveRuntimeSnapshot> {
  const hasOverrides = hasProviderOverrides(params.providerOverrides);
  const sourceConfig = applyProviderOverridesToConfig(
    activeSnapshot.sourceConfig,
    params.providerOverrides,
  );
  const resolvedConfig = applyProviderOverridesToConfig(
    activeSnapshot.config,
    params.providerOverrides,
  );
  const context = hasOverrides
    ? createResolverContext({
        sourceConfig,
        env: getActiveSecretsRuntimeEnvState(),
      })
    : undefined;
  if (context) {
    await resolveRuntimeWebTools({
      sourceConfig,
      resolvedConfig,
      context,
    });
  }
  await resolveForcedActiveCommandSecretTargets({
    sourceConfig,
    resolvedConfig,
    targetIds: params.targetIds,
    allowedPaths: params.allowedPaths,
    forcedActivePaths: params.forcedActivePaths,
    optionalActivePaths: params.optionalActivePaths,
  });

  const warningSource = context?.warnings ?? activeSnapshot.warnings;
  const isInactivePath = (path: string) => {
    if (
      (params.allowedPaths && !params.allowedPaths.has(path)) ||
      params.forcedActivePaths?.has(path) ||
      params.optionalActivePaths?.has(path)
    ) {
      return false;
    }
    return (
      !hasOverrides ||
      !isProviderOverridePath({
        config: sourceConfig,
        path,
        providerOverrides: params.providerOverrides,
      })
    );
  };
  let inactiveRefPaths = [
    ...new Set(
      warningSource
        .filter((warning) => warning.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE")
        .map((warning) => warning.path),
    ),
  ].filter(isInactivePath);
  if (hasOverrides) {
    inactiveRefPaths = restoreInactiveWebCommandSecretTargets({
      sourceConfig,
      resolvedConfig,
      targetIds: params.targetIds,
      inactiveRefPaths,
      isInactivePath,
    });
  }

  const analyzeAssignments = () =>
    analyzeCommandSecretAssignmentsFromSnapshot({
      sourceConfig,
      resolvedConfig,
      targetIds: params.targetIds,
      inactiveRefPaths: new Set(inactiveRefPaths),
      ...(params.allowedPaths ? { allowedPaths: params.allowedPaths } : {}),
    });
  let analyzed = analyzeAssignments();
  if (hasOverrides) {
    const impliedInactivePaths = analyzed.unresolved
      .filter((entry) => pluginIdFromRuntimeWebPath(entry.path))
      .filter(
        (entry) =>
          !isProviderOverridePath({
            config: sourceConfig,
            path: entry.path,
            providerOverrides: params.providerOverrides,
          }),
      )
      .map((entry) => entry.path);
    if (impliedInactivePaths.length > 0) {
      inactiveRefPaths = uniqueStrings([...inactiveRefPaths, ...impliedInactivePaths]);
      analyzed = analyzeAssignments();
    }
  }
  const optionalActiveUnresolvedPaths = analyzed.unresolved
    .filter((entry) => params.optionalActivePaths?.has(entry.path))
    .map((entry) => entry.path);
  if (optionalActiveUnresolvedPaths.length > 0) {
    inactiveRefPaths = uniqueStrings([...inactiveRefPaths, ...optionalActiveUnresolvedPaths]);
    analyzed = analyzeAssignments();
  }
  return {
    // A runtime snapshot can be authoritative for only part of a command's target set.
    // Preserve those values so the caller falls back locally only for unresolved paths.
    assignments: analyzed.assignments,
    diagnostics: analyzed.diagnostics,
    inactiveRefPaths,
  };
}
