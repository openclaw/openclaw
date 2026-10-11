import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { shouldIncludeChannelSetupFeatureForConfig } from "../channels/plugins/bundled-setup-policy.js";
import { applyHistoricalWebhookPins } from "../commands/doctor/shared/legacy-webhook-pins.js";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../config/bundled-channel-config-metadata.generated.js";
import { discoverConfigWidePluginManifestRegistry } from "../config/io.plugin-metadata.js";
import type { LegacyConfigRule } from "../config/legacy.shared.js";
import { cloneConfigWithResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { definePluginDoctorMigrationFromPlans } from "../plugin-sdk/doctor-migration-plan-adapter.js";
import { areBundledPluginsDisabled } from "./bundled-dir.js";
import { resolveBundledPluginScanDir } from "./bundled-plugin-scan.js";
import { hasPluginConfigMigrationSource } from "./config-contract-matches.js";
import { normalizePluginsConfig } from "./config-state.js";
import { findUninspectedPluginDiagnostic } from "./discovery-availability.js";
import { discoverConfiguredPluginLoadPaths } from "./discovery.js";
import { applyPluginDoctorCompatibilitySequence } from "./doctor-compatibility-migration.js";
import { resolvePluginDoctorContractArtifact } from "./doctor-contract-artifact.js";
import { loadLegacyChannelStateMigrationDetector } from "./doctor-contract-legacy-setup.js";
import {
  coercePluginDoctorContractModule,
  type PluginDoctorCompatibilityNormalizer,
  type PluginDoctorContractModule,
  type PluginDoctorStateMigrationEntry,
} from "./doctor-contract-module.js";
import {
  collectRelevantDoctorPluginIds,
  collectRelevantDoctorPluginIdsForTouchedPaths,
} from "./doctor-contract-relevance.js";
import type { PluginDoctorMigrationResourceCollectionParams } from "./doctor-migration-resources.js";
import type { DoctorSessionRouteStateOwner } from "./doctor-session-route-state-owner-types.js";
import { isActivatedManifestOwner } from "./manifest-owner-policy.js";
import { loadBundledPluginManifestRegistry } from "./manifest-registry-build.js";
import type { PluginManifestRegistry } from "./manifest-registry.types.js";
import type { PluginManifestDoctorContract } from "./manifest-types.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";
import { getPluginSetupModuleLoader } from "./plugin-setup-module.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "./public-surface-loader.js";

export { collectRelevantDoctorPluginIds } from "./doctor-contract-relevance.js";

const log = createSubsystemLogger("plugins/doctor-contracts");

const deferredPluginMigrations = new AsyncLocalStorage<ReadonlySet<string>>();

/** Defer unavailable plugin repairs while retaining host-owned historical listener facts. */
export function withDeferredPluginDoctorMigrations<T>(
  pluginIds: readonly string[],
  run: () => T,
): T {
  return deferredPluginMigrations.run(new Set(pluginIds), run);
}

export function isPluginDoctorMigrationDeferred(pluginId: string): boolean {
  return deferredPluginMigrations.getStore()?.has(pluginId) === true;
}

type PluginDoctorContractSurface = keyof PluginManifestDoctorContract;

function declaresPluginDoctorContractSurface(
  declaration: PluginManifestDoctorContract | undefined,
  surface: PluginDoctorContractSurface,
): boolean {
  const value = declaration?.[surface];
  return value === true || (surface === "stateMigrations" && Array.isArray(value));
}

export type {
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationDetection,
} from "./doctor-contract-module.js";

type PluginDoctorContractEntry = Omit<
  ReturnType<typeof coercePluginDoctorContractModule>,
  "summary"
> & {
  pluginId: string;
  origin?: PluginManifestRegistryRecord["origin"];
  historicalWebhookNormalizer?: PluginDoctorCompatibilityNormalizer;
};

export function isTrustedForDurableStores(record: PluginManifestRegistryRecord): boolean {
  return record.origin === "bundled" || record.trustedOfficialInstall === true;
}

type PluginManifestRegistryRecord = PluginManifestRegistry["plugins"][number];

type PluginDoctorRegistryParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
  /** Candidate generation prepared by the install owner before publication. */
  manifestRegistry?: PluginManifestRegistry;
  historicalWebhookListeners?: boolean;
  startup?: boolean;
};

function hasScopedProviderAuthAlias(
  record: PluginManifestRegistryRecord,
  scopedProviderIds: ReadonlySet<string>,
): boolean {
  return Object.entries(record.providerAuthAliases ?? {}).some(([rawAlias, rawTarget]) => {
    if (typeof rawTarget !== "string") {
      return false;
    }
    const target = normalizeProviderId(rawTarget);
    return (
      scopedProviderIds.has(normalizeProviderId(rawAlias)) &&
      target !== "" &&
      record.providers.some((providerId) => normalizeProviderId(providerId) === target)
    );
  });
}

/** Include manifest-owned legacy roots for config repair, never session ownership. */
export function collectDoctorConfigRepairPluginIds(
  raw: unknown,
  touchedPaths?: ReadonlyArray<ReadonlyArray<string>>,
): string[] {
  const config = asNullableRecord(raw);
  if (!config) {
    return [];
  }
  const ids = new Set(
    touchedPaths
      ? collectRelevantDoctorPluginIdsForTouchedPaths({ raw, touchedPaths })
      : collectRelevantDoctorPluginIds(raw),
  );
  const registry = loadPluginManifestRegistryForPluginRegistry({
    config,
    includeDisabled: true,
  });
  for (const plugin of registry.plugins) {
    if (
      hasPluginConfigMigrationSource({
        root: raw,
        pathPatterns: plugin.configContracts?.compatibilityMigrationPaths,
        touchedPaths,
      })
    ) {
      ids.add(plugin.id);
    }
  }
  return [...ids].toSorted();
}

function loadPluginDoctorContractEntry(
  record: PluginManifestRegistryRecord,
  surface: PluginDoctorContractSurface,
): PluginDoctorContractEntry | null {
  const declaration = record.doctorContract;
  // Declarations gate loading only; modules remain authoritative, while absence preserves loading.
  if (declaration && !declaresPluginDoctorContractSurface(declaration, surface)) {
    return null;
  }
  const contractArtifact = resolvePluginDoctorContractArtifact(record);
  if (!contractArtifact) {
    return null;
  }
  try {
    // External packages can be replaced at the same path during this process.
    // Bind Doctor callbacks to the selected inventory, like other setup contracts.
    const loader = getPluginSetupModuleLoader(
      record,
      contractArtifact.modulePath,
      contractArtifact.boundaryRoot,
    );
    const { summary, ...contract } = loader.initialize(() =>
      coercePluginDoctorContractModule(
        loader(contractArtifact.modulePath) as PluginDoctorContractModule,
        record.channels,
      ),
    );
    if (!Object.values(summary).some(Boolean) && surface !== "stateMigrations") {
      return null;
    }
    return { pluginId: record.id, ...contract, origin: record.origin };
  } catch (error) {
    log.warn(
      `failed to load doctor contract for ${record.id} from ${contractArtifact.modulePath}: ${formatErrorMessage(error)}`,
    );
    return null;
  }
}

function resolvePluginDoctorManifestRecords(
  params: PluginDoctorRegistryParams & { artifactPreservingReadOnly?: boolean },
  includeDeferred = false,
): PluginManifestRegistryRecord[] {
  if (params?.pluginIds && params.pluginIds.length === 0) {
    return [];
  }

  const manifestRegistry =
    params.manifestRegistry ??
    loadPluginManifestRegistryForPluginRegistry({
      config: params?.config,
      workspaceDir: params?.workspaceDir,
      env: params.env ?? process.env,
      includeDisabled: true,
      artifactPreservingReadOnly: params.artifactPreservingReadOnly,
    });

  return filterPluginDoctorRecordsByScope(
    manifestRegistry.plugins,
    params.pluginIds,
    includeDeferred,
  );
}

function filterPluginDoctorRecordsByScope(
  records: readonly PluginManifestRegistryRecord[],
  pluginIds?: readonly string[],
  includeDeferred = false,
): PluginManifestRegistryRecord[] {
  const scopedPluginIds = pluginIds ? new Set(pluginIds) : null;
  const scopedProviderIds = pluginIds
    ? new Set(pluginIds.map(normalizeProviderId).filter(Boolean))
    : null;
  return records.filter(
    (record) =>
      (includeDeferred || !isPluginDoctorMigrationDeferred(record.id)) &&
      !(
        scopedPluginIds &&
        !scopedPluginIds.has(record.id) &&
        !(record.packageName && scopedPluginIds.has(record.packageName)) &&
        !record.legacyPluginIds?.some((pluginId) => scopedPluginIds.has(pluginId)) &&
        !record.channels.some((channelId) => scopedPluginIds.has(channelId)) &&
        !record.providers.some((providerId) => scopedPluginIds.has(providerId)) &&
        !(scopedProviderIds && hasScopedProviderAuthAlias(record, scopedProviderIds))
      ),
  );
}

function resolvePluginDoctorContracts(
  params: PluginDoctorRegistryParams & { surface: PluginDoctorContractSurface },
): PluginDoctorContractEntry[] {
  const loadPaths = params.config?.plugins?.load?.paths ?? [];
  if (params.surface === "configRepair" && loadPaths.length > 0) {
    const warning = findUninspectedPluginDiagnostic(
      discoverConfiguredPluginLoadPaths({ loadPaths, env: params.env }).diagnostics,
    );
    if (warning) {
      log.warn(warning.message);
      return [];
    }
  }
  const includeDeferred = params.surface === "configRepair";
  const records = resolvePluginDoctorManifestRecords(params, includeDeferred);
  const entries = loadPluginDoctorContractEntries({
    records: includeDeferred
      ? records.filter((record) => !isPluginDoctorMigrationDeferred(record.id))
      : records,
    surface: params.surface,
  });
  if (params.surface !== "configRepair") {
    return entries;
  }
  for (const { channelId, pluginId } of GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA) {
    // A deferred owner still shadows the host contract even though its code cannot run.
    const owner = records.find(
      (record) => record.id === pluginId || record.channels.includes(channelId),
    );
    const supplement =
      params.historicalWebhookListeners &&
      owner?.id === pluginId &&
      owner.trustedOfficialInstall === true
        ? entries.find((entry) => entry.pluginId === pluginId && !entry.historicalWebhookListener)
        : undefined;
    if (
      (isPluginDoctorMigrationDeferred(pluginId) && !params.historicalWebhookListeners) ||
      (!params.historicalWebhookListeners &&
        !Object.hasOwn(params.config?.channels ?? {}, channelId) &&
        !Object.hasOwn(params.config?.plugins?.entries ?? {}, pluginId)) ||
      (owner && !supplement) ||
      (params.pluginIds &&
        !params.pluginIds.includes(channelId) &&
        !params.pluginIds.includes(pluginId))
    ) {
      continue;
    }
    // Installed owners retain config repair; host contracts can supply historical listener facts.
    // Absent external plugins retain the core-version config migration.
    const mod = loadBundledPluginPublicArtifactModuleFromCandidatesSync<PluginDoctorContractModule>(
      {
        dirName: channelId,
        artifactCandidates: ["config-doctor-api.js"],
        env: params.env,
      },
    );
    if (!mod) {
      continue;
    }
    const { summary: _summary, ...contract } = coercePluginDoctorContractModule(mod, [channelId]);
    if (supplement && contract.historicalWebhookListener && contract.normalizeCompatibilityConfig) {
      supplement.historicalWebhookListener = contract.historicalWebhookListener;
      supplement.historicalWebhookNormalizer = contract.normalizeCompatibilityConfig;
    } else if (!owner) {
      if (isPluginDoctorMigrationDeferred(pluginId)) {
        const normalize = contract.normalizeHistoricalWebhookConfig;
        if (!contract.historicalWebhookListener || !normalize) {
          continue;
        }
        entries.push({
          pluginId,
          ...contract,
          origin: "bundled",
          rules: [],
          // Preserve authored endpoints through their owner without other deferred repairs.
          normalizeCompatibilityConfig: normalize,
        });
      } else {
        entries.push({ pluginId, ...contract, origin: "bundled" });
      }
    }
  }
  return entries;
}

function loadPluginDoctorContractEntries(params: {
  records: PluginManifestRegistryRecord[];
  surface: PluginDoctorContractSurface;
}): PluginDoctorContractEntry[] {
  return params.records.flatMap((record) => {
    const entry = loadPluginDoctorContractEntry(record, params.surface);
    return entry ? [entry] : [];
  });
}
export function listPluginDoctorLegacyConfigRules(
  params?: PluginDoctorRegistryParams & { activeOnly?: boolean },
): LegacyConfigRule[] {
  const entries = params?.activeOnly
    ? loadPluginDoctorContractEntries({
        records: resolvePluginDoctorStateMigrationRecords(params),
        surface: "configRepair",
      })
    : resolvePluginDoctorContracts({ ...params, surface: "configRepair" });
  return entries.flatMap((entry) => entry.rules);
}

export function listPluginDoctorSessionRouteStateOwners(
  params?: PluginDoctorRegistryParams,
): DoctorSessionRouteStateOwner[] {
  const owners = new Map<string, DoctorSessionRouteStateOwner>();
  const records = resolvePluginDoctorManifestRecords(params ?? {});
  const manifestOwners = records.flatMap((record) => record.sessionRouteStateOwners ?? []);
  const legacyModuleOwners = loadPluginDoctorContractEntries({
    records: records.filter((record) => record.sessionRouteStateOwners === undefined),
    surface: "sessionRouteStateOwners",
  }).flatMap((entry) => entry.sessionRouteStateOwners);
  for (const owner of [...manifestOwners, ...legacyModuleOwners]) {
    if (!owners.has(owner.id)) {
      owners.set(owner.id, owner);
    }
  }
  return [...owners.values()].toSorted((left, right) => left.id.localeCompare(right.id));
}

/** Resolve plugin-owned agent IDs whose core session stores need migration. */
export function listPluginDoctorSessionStoreAgentIds(
  params?: PluginDoctorRegistryParams,
): string[] {
  const cfg = params?.config ?? {};
  const agentIds = new Set<string>();
  for (const entry of resolvePluginDoctorContracts({
    ...params,
    surface: "resolveSessionStoreAgentIds",
  })) {
    let resolved: readonly string[] | undefined;
    try {
      resolved = entry.resolveSessionStoreAgentIds?.({ cfg });
    } catch {
      // A plugin-owned hint must never block core startup migration.
      continue;
    }
    for (const agentId of normalizeTrimmedStringList(resolved)) {
      agentIds.add(agentId);
    }
  }
  return [...agentIds].toSorted();
}

export class PluginDoctorStateMigrationDeclarationError extends Error {}

export function listPluginDoctorStateMigrationEntries(
  params?: PluginDoctorRegistryParams & {
    inventory?: PluginDoctorStateMigrationInventory;
    validateDeclarations?: boolean;
    onSelectedPlugin?: (pluginId: string) => void;
    onInspectedPlugin?: (pluginId: string) => void;
    onInspectedStatelessPlugin?: (pluginId: string) => void;
  },
): PluginDoctorStateMigrationEntry[] {
  return loadPluginDoctorStateMigrationEntries(
    params?.inventory?.records ?? resolvePluginDoctorStateMigrationRecords(params ?? {}),
    params?.validateDeclarations,
    params?.onInspectedPlugin,
    params?.onInspectedStatelessPlugin,
    params?.onSelectedPlugin,
  );
}

function loadPluginDoctorStateMigrationEntries(
  records: readonly PluginManifestRegistryRecord[],
  validateDeclarations = true,
  onInspectedPlugin?: (pluginId: string) => void,
  onInspectedStatelessPlugin?: (pluginId: string) => void,
  onSelectedPlugin?: (pluginId: string) => void,
): PluginDoctorStateMigrationEntry[] {
  const entries: PluginDoctorStateMigrationEntry[] = [];
  for (const record of records) {
    onSelectedPlugin?.(record.id);
    const modern = loadPluginDoctorContractEntry(record, "stateMigrations");
    const declaration = record.doctorContract?.stateMigrations;
    const migrations = modern?.stateMigrations ?? [];
    // Validate the whole declaration before callers select a phase or authority.
    // Otherwise an undeclared post-session action can hide behind an empty phase.
    if (
      validateDeclarations &&
      Array.isArray(declaration) &&
      (declaration.length !== migrations.length ||
        declaration.some((action, index) => {
          const migration = migrations[index];
          return (
            action.id !== migration?.id ||
            (action.doctorOnly === true) !== (migration?.doctorOnly === true) ||
            action.phase !== migration?.phase
          );
        }))
    ) {
      throw new PluginDoctorStateMigrationDeclarationError(
        `Refused plugin migrations that do not match the immutable action order and authority declared by ${record.id}.`,
      );
    }
    if (modern?.stateMigrations.length) {
      onInspectedPlugin?.(record.id);
      for (const migration of modern.stateMigrations) {
        entries.push({
          pluginId: modern.pluginId,
          channelIds: record.channels,
          trustedForDurableStores: isTrustedForDurableStores(record),
          migration,
        });
      }
      continue;
    }
    if (declaresPluginDoctorContractSurface(record.doctorContract, "stateMigrations")) {
      if (modern && Array.isArray(declaration) && declaration.length === 0) {
        onInspectedStatelessPlugin?.(record.id);
      }
      continue;
    }
    if (record.channels.length === 0 || record.origin === "bundled") {
      if (modern) {
        onInspectedStatelessPlugin?.(record.id);
      }
      continue;
    }

    // Released external plugins retain their own setup-entry detector through 2027.1; resolving
    // the winning manifest's validated setupSource avoids loading a shadowed bundled plugin.
    const detector = loadLegacyChannelStateMigrationDetector(record, onInspectedStatelessPlugin);
    if (!detector) {
      if (modern && !record.setupSource) {
        onInspectedStatelessPlugin?.(record.id);
      }
      continue;
    }
    onInspectedPlugin?.(record.id);
    entries.push({
      pluginId: record.id,
      channelIds: record.channels,
      trustedForDurableStores: isTrustedForDurableStores(record),
      migration: definePluginDoctorMigrationFromPlans({
        id: `${record.id}-legacy-channel-state`,
        label: `${record.id} legacy channel state`,
        resolvePlans: detector,
      }),
    });
  }
  return entries;
}

export function resolvePluginDoctorStateMigrationRecords(
  params: PluginDoctorRegistryParams & { artifactPreservingReadOnly?: boolean },
): PluginManifestRegistryRecord[] {
  if (params.pluginIds?.length === 0) {
    return [];
  }
  const registry = params.manifestRegistry ?? discoverConfigWidePluginManifestRegistry(params);
  return filterPluginDoctorStateMigrationRecords(
    filterPluginDoctorRecordsByScope(registry.plugins, params.pluginIds),
    params.config,
  );
}

function filterPluginDoctorStateMigrationRecords(
  candidates: readonly PluginManifestRegistryRecord[],
  config?: OpenClawConfig,
): PluginManifestRegistryRecord[] {
  const records: PluginManifestRegistryRecord[] = [];
  const normalizedConfig = normalizePluginsConfig(config?.plugins);
  for (const record of candidates) {
    if (deferredPluginMigrations.getStore()?.has(record.id)) {
      continue;
    }
    const channelOwner = record.channels.length > 0;
    // Config repair intentionally includes disabled plugins; channel state must never be moved
    // after its operator has disabled the owning plugin or every configured channel.
    if (
      channelOwner &&
      !shouldIncludeChannelSetupFeatureForConfig({
        plugin: record,
        config,
        normalizedConfig,
      })
    ) {
      continue;
    }
    // Trusted bundled non-channel migrations remain available while plugins are globally disabled.
    // Every non-bundled owner must pass normal activation before either artifact can execute.
    if (
      record.origin !== "bundled" &&
      !isActivatedManifestOwner({ plugin: record, normalizedConfig, rootConfig: config })
    ) {
      continue;
    }
    records.push(record);
  }
  // Alias cleanup can change discovery order without changing migration owners.
  // Stabilize owner order while preserving each owner's declared action order.
  return records.toSorted((left, right) => left.id.localeCompare(right.id));
}

export type PluginDoctorStateMigrationInventory = {
  /** Live selection, retained across maintenance scopes without rediscovery. */
  records?: readonly PluginManifestRegistryRecord[];
  knownPluginIds: string[];
  sessionStoreOwnerPluginIds: string[];
  descriptors: Array<{
    pluginId: string;
    id: string;
    doctorOnly?: true;
    phase?: "after-session-repair";
  }>;
  unresolvedPluginIds: string[];
  resolutionFailure?: { code: string; message: string };
};

/**
 * Read candidate-bundled migration identities without importing Doctor contract modules.
 * Installed plugin artifacts are outside the candidate and copied-state identity boundary;
 * candidate staging must bind them before their descriptors can authorize execution.
 */
function listPluginDoctorStateMigrationInventory(params?: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  candidateRoot?: string;
}): PluginDoctorStateMigrationInventory {
  const knownPluginIds: string[] = [];
  const sessionStoreOwnerPluginIds: string[] = [];
  const descriptors: PluginDoctorStateMigrationInventory["descriptors"] = [];
  const unresolvedPluginIds: string[] = [];
  const candidateBundledRoot = params?.candidateRoot
    ? resolveBundledPluginScanDir({
        packageRoot: path.resolve(params.candidateRoot),
        runningFromBuiltArtifact: true,
      })
    : undefined;
  const bundled = params?.candidateRoot
    ? candidateBundledRoot && !areBundledPluginsDisabled(params.env)
      ? loadBundledPluginManifestRegistry({
          env: { ...params.env, OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1" },
          bundledRoot: candidateBundledRoot,
        }).plugins
      : []
    : loadBundledPluginManifestRegistry({ env: params?.env }).plugins;
  knownPluginIds.push(...bundled.map((record) => record.id));
  for (const record of filterPluginDoctorStateMigrationRecords(bundled, params?.config)) {
    if (record.doctorContract?.resolveSessionStoreAgentIds === true) {
      sessionStoreOwnerPluginIds.push(record.id);
    }
    const declaration = record.doctorContract?.stateMigrations;
    if (Array.isArray(declaration)) {
      descriptors.push(
        ...declaration.map((migration) => Object.assign({ pluginId: record.id }, migration)),
      );
      continue;
    }
    if (declaration === true) {
      unresolvedPluginIds.push(record.id);
    }
  }
  return { knownPluginIds, sessionStoreOwnerPluginIds, descriptors, unresolvedPluginIds };
}

/** Resolve the bundled action inventory plus every configured owner that is not identity-bound. */
export function resolvePluginDoctorStateMigrationInventory(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  candidateRoot?: string;
  artifactPreservingReadOnly?: boolean;
}): PluginDoctorStateMigrationInventory {
  const inventory = listPluginDoctorStateMigrationInventory(params);
  const hasConfiguredLoadPaths =
    params.config.plugins?.load?.paths?.some((entry) => entry.trim().length > 0) === true;
  let externallySelectedPluginIds = new Set<string>();
  try {
    externallySelectedPluginIds = new Set(
      // Selection and activation differ: a disabled external winner still shadows
      // the bundled artifact, so its bundled actions cannot authorize a copied plan.
      resolvePluginDoctorManifestRecords(params)
        .filter((record) => record.origin !== "bundled")
        .map((record) => record.id),
    );
  } catch {
    // Shared-state schema repair owns unreadable registry diagnostics. Keep the bundled and
    // explicitly configured inventory stable so that refusal can close every later receipt.
  }
  const relevantPluginIds = collectRelevantDoctorPluginIds(params.config);
  const knownPluginIds = inventory.knownPluginIds.filter(
    (pluginId) => !externallySelectedPluginIds.has(pluginId),
  );
  const sessionStoreOwnerPluginIds = inventory.sessionStoreOwnerPluginIds.filter(
    (pluginId) => !externallySelectedPluginIds.has(pluginId),
  );
  const descriptors = inventory.descriptors.filter(
    (descriptor) => !externallySelectedPluginIds.has(descriptor.pluginId),
  );
  const describedPluginIds = new Set([
    ...knownPluginIds,
    ...descriptors.map((descriptor) => descriptor.pluginId),
    ...inventory.unresolvedPluginIds,
  ]);
  const unresolvedPluginIds = [
    ...inventory.unresolvedPluginIds,
    ...externallySelectedPluginIds,
    ...relevantPluginIds.filter((pluginId) => !describedPluginIds.has(pluginId)),
  ];
  if (hasConfiguredLoadPaths) {
    // A configured path can override any bundled ID. Its manifest bytes are outside the
    // candidate identity, so no bundled descriptor may authorize the selected artifact.
    unresolvedPluginIds.push("configured-load-paths");
  }
  return {
    knownPluginIds,
    sessionStoreOwnerPluginIds,
    descriptors,
    unresolvedPluginIds: [...new Set(unresolvedPluginIds)].toSorted(),
  };
}

/** Freeze the live registry's selected migration actions before state mutation. */
export function resolveLivePluginDoctorStateMigrationInventory(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): PluginDoctorStateMigrationInventory {
  const bundledInventory = listPluginDoctorStateMigrationInventory(params);
  let records: PluginManifestRegistryRecord[];
  try {
    records = resolvePluginDoctorStateMigrationRecords({
      ...params,
      artifactPreservingReadOnly: true,
    });
  } catch (error) {
    // Keep metadata for an early refusal, but never treat failed live discovery as
    // a complete empty inventory. Preparation may refresh it after schema repair.
    return {
      ...bundledInventory,
      unresolvedPluginIds: [],
      resolutionFailure: {
        code: "plugin-inventory-unavailable",
        message: `Could not resolve live plugin migration inventory: ${formatErrorMessage(error)}`,
      },
    };
  }

  const descriptors: PluginDoctorStateMigrationInventory["descriptors"] = [];
  for (const record of records) {
    const declaration = record.doctorContract?.stateMigrations;
    if (Array.isArray(declaration)) {
      descriptors.push(
        ...declaration.map((migration) => Object.assign({ pluginId: record.id }, migration)),
      );
      continue;
    }
    descriptors.push(
      ...loadPluginDoctorStateMigrationEntries([record]).map(({ pluginId, migration }) =>
        Object.assign(
          { pluginId, id: migration.id },
          migration.doctorOnly === true ? { doctorOnly: true as const } : {},
          migration.phase === "after-session-repair" ? { phase: migration.phase } : {},
        ),
      ),
    );
  }

  return {
    records,
    knownPluginIds: [...new Set([...bundledInventory.knownPluginIds, ...records.map((r) => r.id)])],
    sessionStoreOwnerPluginIds: records
      .filter((record) => record.doctorContract?.resolveSessionStoreAgentIds === true)
      .map((record) => record.id),
    descriptors,
    unresolvedPluginIds: [],
  };
}

export function applyPluginDoctorCompatibilityMigrations(
  cfg: OpenClawConfig,
  params?: PluginDoctorRegistryParams & {
    onInspectedPlugin?: (pluginId: string, hasConfigRepair: boolean) => void;
  },
): ReturnType<typeof applyPluginDoctorCompatibilitySequence> {
  const initialized = params?.historicalWebhookListeners
    ? applyHistoricalWebhookPins({ config: cfg, changes: [] }, undefined, params)
    : { config: cfg, changes: [] };
  const result = applyPluginDoctorCompatibilitySequence(
    initialized.config,
    resolvePluginDoctorContracts({
      ...params,
      config: params?.config ?? cfg,
      surface: "configRepair",
    }).map((entry) => {
      if (!isPluginDoctorMigrationDeferred(entry.pluginId)) {
        params?.onInspectedPlugin?.(
          entry.pluginId,
          entry.rules.length > 0 || Boolean(entry.normalizeCompatibilityConfig),
        );
      }
      return {
        pluginId: entry.pluginId,
        normalizeCompatibilityConfig: entry.normalizeCompatibilityConfig,
        transform: params?.historicalWebhookListeners
          ? (mutation: ReturnType<PluginDoctorCompatibilityNormalizer>) => {
              if (entry.historicalWebhookNormalizer) {
                mutation.historicalWebhookAccountIds = entry.historicalWebhookNormalizer({
                  cfg: cloneConfigWithResolutionFacts(mutation.config),
                }).historicalWebhookAccountIds;
              }
              const context = { ...params, pluginId: entry.pluginId, origin: entry.origin };
              return applyHistoricalWebhookPins(mutation, entry.historicalWebhookListener, context);
            }
          : undefined,
      };
    }),
  );
  return { ...result, changes: [...initialized.changes, ...result.changes] };
}

/** Inspect plugin-owned migration paths before the updater captures its recovery set. */
export async function preparePluginDoctorMigrationBackupResources(
  params: PluginDoctorMigrationResourceCollectionParams,
) {
  return await withPluginSourceCaptureStorage(
    { stateDir: params.stateDir, placement: "temporary" },
    async () => {
      const entries = loadPluginDoctorStateMigrationEntries(
        resolvePluginDoctorStateMigrationRecords({ ...params, artifactPreservingReadOnly: true }),
      );
      const { preparePluginDoctorMigrationResources } =
        await import("./doctor-migration-resources.js");
      return await preparePluginDoctorMigrationResources(entries, params);
    },
  );
}
