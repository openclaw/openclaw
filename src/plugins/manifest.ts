/** Loads and normalizes OpenClaw plugin manifests, including contracts and config schemas. */
import path from "node:path";
import { normalizeModelPricingProvider } from "@openclaw/model-catalog-core/model-catalog-pricing";
import { normalizeModelCatalogProviderId } from "@openclaw/model-catalog-core/model-catalog-refs";
import { validatePluginUiCapabilities } from "../../packages/gateway-protocol/src/plugin-ui-capabilities.js";
import { asSafeIntegerInRange } from "../../packages/normalization-core/src/number-coercion.js";
import { omitUndefinedFields } from "../../packages/normalization-core/src/record-coerce.js";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import {
  normalizeOptionalTrimmedStringList,
  normalizeTrimmedStringList,
} from "../../packages/normalization-core/src/string-normalization.js";
import { validatePluginCategories } from "../../packages/plugin-package-contract/src/index.js";
import { ENV_SECRET_REF_ID_RE } from "../config/types.secrets.js";
import { matchRootFileOpenFailure } from "../infra/boundary-file-read.js";
import type { ConfigUiGroup } from "../shared/config-ui-hints-types.js";
import { isRecord } from "../utils.js";
import { loadPluginControlUiDeclaration } from "./control-ui-build-manifest.js";
import { coerceDoctorSessionRouteStateOwners } from "./doctor-session-route-state-owner-types.js";
import * as capabilityNormalizers from "./manifest-capability-normalizers.js";
import { normalizeManifestCommandAliases } from "./manifest-command-aliases.js";
import { normalizeManifestModelCatalog } from "./manifest-decision-catalog.js";
import { normalizeManifestPlatforms } from "./manifest-platforms.js";
import * as setupNormalizers from "./manifest-setup-normalizers.js";
import { normalizeManifestThemes } from "./manifest-themes.js";
import type {
  PluginManifestModelIdNormalization,
  PluginManifestModelIdNormalizationProvider,
  PluginManifestModelIdPrefixRule,
  PluginManifestModelPricing,
  PluginManifestModelSupport,
  PluginManifestProviderRequest,
  PluginManifestSecretProviderIntegration,
  PluginManifestBackupResource,
  PluginManifestDoctorContract,
} from "./manifest-types.js";
import { parsePluginCacheJson, readPluginCacheFile } from "./plugin-cache-files.js";
import type { CachedPluginManifestResult as PluginManifestLoadResult } from "./plugin-cache-files.types.js";
import type { PluginKind } from "./plugin-kind.types.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";
import { normalizeManifestProviderRequestProvider } from "./plugin-provider-request-policy.js";

export type * from "./manifest-types.js";
export * from "./package-manifest.js";
export {
  normalizeManifestActivation,
  normalizeManifestChannelCommandDefaults,
} from "./manifest-setup-normalizers.js";

/** Canonical plugin manifest filename inside plugin roots. */
export const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
const MAX_PLUGIN_MANIFEST_BYTES = 256 * 1024;
const CORE_RESERVED_PLUGIN_IDS = new Set(["node-mcp"]);
const VALID_PLUGIN_KINDS: ReadonlySet<string> = new Set<PluginKind>(["memory", "context-engine"]);

export function isCoreReservedPluginId(id: string): boolean {
  return CORE_RESERVED_PLUGIN_IDS.has(normalizePluginPolicyId(id));
}

function parsePluginKind(raw: unknown): PluginKind | PluginKind[] | undefined {
  const values = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const kinds: PluginKind[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !VALID_PLUGIN_KINDS.has(value)) {
      continue;
    }
    const kind = value as PluginKind;
    if (!kinds.includes(kind)) {
      kinds.push(kind);
    }
  }
  return kinds.length === 0 ? undefined : kinds.length === 1 ? kinds[0] : kinds;
}

function parseDoctorStateMigrationDescriptors(
  raw: unknown,
): PluginManifestDoctorContract["stateMigrations"] {
  if (typeof raw === "boolean") {
    return raw;
  }
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const seen = new Set<string>();
  return raw.flatMap((value) => {
    if (!isRecord(value)) {
      return [];
    }
    const id = normalizeOptionalString(value.id);
    if (!id || seen.has(id)) {
      return [];
    }
    seen.add(id);
    return [
      {
        id,
        ...(value.doctorOnly === true ? { doctorOnly: true as const } : {}),
        ...(value.phase === "after-session-repair"
          ? { phase: "after-session-repair" as const }
          : {}),
      },
    ];
  });
}

function parseManifestBackupResources(
  raw: unknown,
): { ok: true; resources?: PluginManifestBackupResource[] } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: "backupResources must be an array" };
  }
  const resources = new Map<string, PluginManifestBackupResource>();
  for (const [index, entry] of raw.entries()) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).some(
        (key) => !["disposition", "scope", "relativePath", "databaseFamily"].includes(key),
      ) ||
      !("disposition" in entry) ||
      !("scope" in entry) ||
      !("relativePath" in entry)
    ) {
      return {
        ok: false,
        error: `backupResources[${index}] requires disposition, scope, relativePath, and optional databaseFamily`,
      };
    }
    const { disposition, scope, relativePath, databaseFamily } = entry;
    if (disposition !== "include" && disposition !== "regenerable") {
      return { ok: false, error: `backupResources[${index}].disposition is invalid` };
    }
    if (scope !== "state" && scope !== "agent") {
      return { ok: false, error: `backupResources[${index}].scope is invalid` };
    }
    if (
      databaseFamily !== undefined &&
      (disposition !== "include" || scope !== "state" || databaseFamily !== "state")
    ) {
      return { ok: false, error: `backupResources[${index}].databaseFamily is invalid` };
    }
    if (
      typeof relativePath !== "string" ||
      !relativePath ||
      relativePath.includes("\\") ||
      relativePath.includes("\0") ||
      path.posix.isAbsolute(relativePath) ||
      path.win32.isAbsolute(relativePath) ||
      /^[A-Za-z][A-Za-z\d+.-]*:/.test(relativePath) ||
      relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ) {
      return {
        ok: false,
        error: `backupResources[${index}].relativePath must be a strict relative POSIX path`,
      };
    }
    const resource: PluginManifestBackupResource = {
      disposition,
      scope,
      relativePath,
      ...(databaseFamily !== undefined ? { databaseFamily } : {}),
    };
    resources.set(`${scope}\0${relativePath}\0${disposition}\0${databaseFamily ?? ""}`, resource);
  }
  return {
    ok: true,
    resources: [...resources.entries()]
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, resource]) => resource),
  };
}

const MAX_SECRET_PROVIDER_EXEC_ARGS = 128;
const MAX_SECRET_PROVIDER_EXEC_ARG_BYTES = 1024;
const MAX_SECRET_PROVIDER_EXEC_TIMEOUT_MS = 120_000;
const MAX_SECRET_PROVIDER_EXEC_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_SECRET_PROVIDER_EXEC_PASS_ENV = 128;
const SECRET_PROVIDER_NODE_COMMAND_PLACEHOLDER = "${node}";

function normalizeManifestModelSupport(value: unknown): PluginManifestModelSupport | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return capabilityNormalizers.optionalManifestFields({
    modelPrefixes: normalizeOptionalTrimmedStringList(value.modelPrefixes),
    modelPatterns: normalizeOptionalTrimmedStringList(value.modelPatterns),
  });
}

function normalizeOwnedProviderMap<T>(
  value: unknown,
  ownedProvidersRaw: ReadonlySet<string>,
  normalizePolicy: (value: unknown) => T | undefined,
): Record<string, T> | undefined {
  if (!isRecord(value) || !isRecord(value.providers)) {
    return undefined;
  }
  const ownedProviders = new Set(
    [...ownedProvidersRaw]
      .map((provider) => normalizeModelCatalogProviderId(provider))
      .filter(Boolean),
  );
  const providers: Record<string, T> = {};
  for (const [rawProviderId, rawPolicy] of Object.entries(value.providers)) {
    const providerId = normalizeModelCatalogProviderId(rawProviderId);
    const policy = providerId && ownedProviders.has(providerId) ? normalizePolicy(rawPolicy) : null;
    if (providerId && policy) {
      providers[providerId] = policy;
    }
  }
  return Object.keys(providers).length > 0 ? providers : undefined;
}

function normalizeManifestModelPricing(
  value: unknown,
  params: { ownedProviders: ReadonlySet<string> },
): PluginManifestModelPricing | undefined {
  const providers = normalizeOwnedProviderMap(
    value,
    params.ownedProviders,
    normalizeModelPricingProvider,
  );
  return providers ? { providers } : undefined;
}

function normalizeManifestModelIdPrefixRules(
  value: unknown,
): PluginManifestModelIdPrefixRule[] | undefined {
  return capabilityNormalizers.normalizeManifestObjectList(value, (rawRule) => {
    const modelPrefix = normalizeOptionalString(rawRule.modelPrefix);
    const prefix = normalizeOptionalString(rawRule.prefix);
    return modelPrefix && prefix ? { modelPrefix, prefix } : undefined;
  });
}

function normalizeManifestModelIdNormalizationProvider(
  value: unknown,
): PluginManifestModelIdNormalizationProvider | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const aliases: Record<string, string> = {};
  if (isRecord(value.aliases)) {
    for (const [rawAlias, rawCanonical] of Object.entries(value.aliases)) {
      const alias = normalizeModelCatalogProviderId(rawAlias);
      const canonical = normalizeOptionalString(rawCanonical);
      if (alias && canonical) {
        aliases[alias] = canonical;
      }
    }
  }
  return capabilityNormalizers.optionalManifestFields({
    aliases: Object.keys(aliases).length > 0 ? aliases : undefined,
    stripPrefixes: normalizeOptionalTrimmedStringList(value.stripPrefixes),
    prefixWhenBare: normalizeOptionalString(value.prefixWhenBare),
    prefixWhenBareAfterAliasStartsWith: normalizeManifestModelIdPrefixRules(
      value.prefixWhenBareAfterAliasStartsWith,
    ),
  });
}

function normalizeManifestModelIdNormalization(
  value: unknown,
  params: { ownedProviders: ReadonlySet<string> },
): PluginManifestModelIdNormalization | undefined {
  const providers = normalizeOwnedProviderMap(
    value,
    params.ownedProviders,
    normalizeManifestModelIdNormalizationProvider,
  );
  return providers ? { providers } : undefined;
}

function normalizeManifestProviderRequest(
  value: unknown,
  params: { ownedProviders: ReadonlySet<string> },
): PluginManifestProviderRequest | undefined {
  const providers = normalizeOwnedProviderMap(
    value,
    params.ownedProviders,
    normalizeManifestProviderRequestProvider,
  );
  return providers ? { providers } : undefined;
}

function normalizeManifestPositiveInteger(value: unknown, max: number): number | undefined {
  return asSafeIntegerInRange(value, { min: 1, max });
}

function normalizeManifestSecretProviderIntegrations(
  value: unknown,
): Record<string, PluginManifestSecretProviderIntegration> | undefined {
  return capabilityNormalizers.normalizeNamedMetadataRecord(value, (rawIntegration) => {
    const command = normalizeOptionalString(rawIntegration.command);
    if (rawIntegration.source !== "exec" || command !== SECRET_PROVIDER_NODE_COMMAND_PLACEHOLDER) {
      return undefined;
    }
    const args: string[] = [];
    if (Array.isArray(rawIntegration.args)) {
      for (const entry of rawIntegration.args) {
        if (typeof entry !== "string" || entry.length > MAX_SECRET_PROVIDER_EXEC_ARG_BYTES) {
          continue;
        }
        args.push(entry);
        if (args.length >= MAX_SECRET_PROVIDER_EXEC_ARGS) {
          break;
        }
      }
    }
    const passEnv = normalizeTrimmedStringList(rawIntegration.passEnv)
      .filter((entry) => ENV_SECRET_REF_ID_RE.test(entry))
      .slice(0, MAX_SECRET_PROVIDER_EXEC_PASS_ENV);
    return omitUndefinedFields<PluginManifestSecretProviderIntegration>({
      providerAlias: normalizeOptionalString(rawIntegration.providerAlias),
      displayName: normalizeOptionalString(rawIntegration.displayName),
      description: normalizeOptionalString(rawIntegration.description),
      source: "exec",
      command,
      args: args.length > 0 ? args : undefined,
      timeoutMs: normalizeManifestPositiveInteger(
        rawIntegration.timeoutMs,
        MAX_SECRET_PROVIDER_EXEC_TIMEOUT_MS,
      ),
      noOutputTimeoutMs: normalizeManifestPositiveInteger(
        rawIntegration.noOutputTimeoutMs,
        MAX_SECRET_PROVIDER_EXEC_TIMEOUT_MS,
      ),
      maxOutputBytes: normalizeManifestPositiveInteger(
        rawIntegration.maxOutputBytes,
        MAX_SECRET_PROVIDER_EXEC_OUTPUT_BYTES,
      ),
      jsonOnly: typeof rawIntegration.jsonOnly === "boolean" ? rawIntegration.jsonOnly : undefined,
      env: capabilityNormalizers.normalizeManifestStringRecord(rawIntegration.env),
      passEnv: passEnv.length > 0 ? passEnv : undefined,
    });
  });
}

/** Invalid presentation metadata leaves the plugin's complete flat settings form available. */
function normalizeConfigGroups(
  raw: unknown,
  schema: Record<string, unknown>,
): ConfigUiGroup[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || !isRecord(schema.properties)) {
    return undefined;
  }
  const ids = new Set<string>();
  const assigned = new Set<string>();
  const groups: ConfigUiGroup[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const title = typeof entry.title === "string" ? entry.title.trim() : "";
    if (
      !id ||
      !title ||
      ids.has(id) ||
      (entry.order !== undefined && !Number.isInteger(entry.order)) ||
      !Array.isArray(entry.properties) ||
      entry.properties.length === 0
    ) {
      return undefined;
    }
    const properties: string[] = [];
    for (const property of entry.properties) {
      if (
        typeof property !== "string" ||
        !property ||
        !Object.hasOwn(schema.properties, property) ||
        assigned.has(property)
      ) {
        return undefined;
      }
      assigned.add(property);
      properties.push(property);
    }
    ids.add(id);
    groups.push({
      id,
      title,
      ...(typeof entry.order === "number" ? { order: entry.order } : {}),
      properties,
    });
  }
  return groups;
}

export function loadPluginManifest(
  rootDir: string,
  rejectHardlinks = true,
  rootRealPath?: string,
): PluginManifestLoadResult {
  const file = readPluginCacheFile({
    rootDir,
    relativePath: PLUGIN_MANIFEST_FILENAME,
    ...(rootRealPath !== undefined ? { rootRealPath } : {}),
    maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
    rejectHardlinks,
  });
  // Aliased roots share this cached result, so retain the checked file's identity
  // rather than the first caller's path for canonical-root registry/hash reads.
  const manifestPath = file.ok ? file.path : path.join(rootDir, PLUGIN_MANIFEST_FILENAME);
  if (!file.ok) {
    return matchRootFileOpenFailure(file.failure, {
      path: () => ({
        ok: false,
        error: `plugin manifest not found: ${manifestPath}`,
        manifestPath,
      }),
      fallback: (failure) => ({
        ok: false,
        error: `unsafe plugin manifest path: ${manifestPath} (${failure.reason})`,
        manifestPath,
      }),
    });
  }
  if (file.manifest) {
    return file.manifest;
  }
  const cacheResult = (result: PluginManifestLoadResult): PluginManifestLoadResult => {
    return (file.manifest = result);
  };
  const fail = (error: string): PluginManifestLoadResult =>
    cacheResult({ ok: false, error, manifestPath });
  const parsed = parsePluginCacheJson(file, { json5: true });
  if (!parsed.ok) {
    return fail(`failed to parse plugin manifest: ${String(parsed.error)}`);
  }
  const raw = parsed.value;
  if (!isRecord(raw)) {
    return fail("plugin manifest must be an object");
  }
  const id = normalizeOptionalString(raw.id) ?? "";
  if (!id) {
    return fail("plugin manifest requires id");
  }
  if (isCoreReservedPluginId(id)) {
    return fail(`plugin manifest id "${id}" is reserved by OpenClaw core`);
  }
  const configSchema = isRecord(raw.configSchema) ? raw.configSchema : null;
  if (!configSchema) {
    return fail("plugin manifest requires configSchema");
  }
  const backupResources = parseManifestBackupResources(raw.backupResources);
  if (!backupResources.ok) {
    return cacheResult({
      ok: false,
      error: `invalid plugin manifest backupResources: ${backupResources.error}`,
      manifestPath,
      diagnosticCode: "backup-resource-declaration-invalid",
    });
  }
  const categories = validatePluginCategories(raw.categories);
  if (!categories.ok) {
    return fail(`invalid plugin manifest categories: ${categories.error}`);
  }

  const requiresPlugins = normalizeTrimmedStringList(raw.requiresPlugins);
  const enabledByDefaultOnPlatforms = normalizeManifestPlatforms(raw.enabledByDefaultOnPlatforms);
  const legacyPluginIds = normalizeTrimmedStringList(raw.legacyPluginIds);
  const autoEnableWhenConfiguredProviders = normalizeTrimmedStringList(
    raw.autoEnableWhenConfiguredProviders,
  );
  const providers = normalizeTrimmedStringList(raw.providers);
  const channels = normalizeTrimmedStringList(raw.channels);
  const contracts = capabilityNormalizers.normalizeManifestContracts(raw.contracts);
  const cliBackends = normalizeTrimmedStringList(raw.cliBackends);
  const rawDoctorContract = isRecord(raw.doctorContract) ? raw.doctorContract : undefined;
  const stateMigrations = parseDoctorStateMigrationDescriptors(rawDoctorContract?.stateMigrations);
  const doctorContract = rawDoctorContract
    ? ({
        ...Object.fromEntries(
          ["configRepair", "resolveSessionStoreAgentIds", "sessionRouteStateOwners"].flatMap(
            (key) =>
              typeof rawDoctorContract[key] === "boolean" ? [[key, rawDoctorContract[key]]] : [],
          ),
        ),
        ...(stateMigrations !== undefined ? { stateMigrations } : {}),
      } as PluginManifestDoctorContract)
    : undefined;
  let modelCatalog: ReturnType<typeof normalizeManifestModelCatalog>;
  try {
    modelCatalog = normalizeManifestModelCatalog({
      modelCatalog: raw.modelCatalog,
      decisionModels: raw.decisionModels,
      providers,
      cliBackends,
      decisionProviders: contracts?.decisionProviders,
    });
  } catch {
    return cacheResult({
      ok: false,
      error: "invalid plugin manifest modelCatalog ownership metadata",
      manifestPath,
    });
  }
  const manifestBeforeDashboard = {
    id,
    configSchema,
    ...("categories" in categories ? { categories: categories.categories } : {}),
    ...(backupResources.resources !== undefined
      ? { backupResources: backupResources.resources }
      : {}),
    ...(requiresPlugins.length > 0 ? { requiresPlugins } : {}),
    ...(raw.enabledByDefault === true ? { enabledByDefault: true } : {}),
    ...(enabledByDefaultOnPlatforms.length > 0 ? { enabledByDefaultOnPlatforms } : {}),
    ...(legacyPluginIds.length > 0 ? { legacyPluginIds } : {}),
    ...(autoEnableWhenConfiguredProviders.length > 0 ? { autoEnableWhenConfiguredProviders } : {}),
    kind: parsePluginKind(raw.kind),
    channels,
    channelAccountKeyPolicies: setupNormalizers.normalizeChannelAccountKeyPolicies(
      raw.channelAccountKeyPolicies,
      channels,
    ),
    providers,
    ...(raw.managesOwnAvailability === true ? { managesOwnAvailability: true } : {}),
    providerCatalogEntry: normalizeOptionalString(raw.providerCatalogEntry),
    capabilityCatalogEntry:
      raw.capabilityCatalogEntry === undefined
        ? undefined
        : (normalizeOptionalString(raw.capabilityCatalogEntry) ?? ""),
    modelSupport: normalizeManifestModelSupport(raw.modelSupport),
    modelCatalog,
    // CLI backends own pricing policies as they own catalog rows: their usage needs an estimate too.
    modelPricing: normalizeManifestModelPricing(raw.modelPricing, {
      ownedProviders: new Set([...providers, ...cliBackends]),
    }),
    modelIdNormalization: normalizeManifestModelIdNormalization(raw.modelIdNormalization, {
      ownedProviders: new Set(providers),
    }),
    providerEndpoints: capabilityNormalizers.normalizeManifestProviderEndpoints(
      raw.providerEndpoints,
    ),
    providerRequest: normalizeManifestProviderRequest(raw.providerRequest, {
      ownedProviders: new Set(providers),
    }),
    secretProviderIntegrations: normalizeManifestSecretProviderIntegrations(
      raw.secretProviderIntegrations,
    ),
    cliBackends,
    syntheticAuthRefs: normalizeTrimmedStringList(raw.syntheticAuthRefs),
    nonSecretAuthMarkers: normalizeTrimmedStringList(raw.nonSecretAuthMarkers),
    commandAliases: normalizeManifestCommandAliases(raw.commandAliases),
    cliCommands: setupNormalizers.normalizeManifestCliCommands(raw.cliCommands),
    providerUsageAuthEnvVars: capabilityNormalizers.normalizeStringListRecord(
      raw.providerUsageAuthEnvVars,
    ),
    providerAuthAliases: capabilityNormalizers.normalizeManifestProviderAuthAliases(
      raw.providerAuthAliases,
    ),
    providerAuthChoices: setupNormalizers.normalizeProviderAuthChoices(raw.providerAuthChoices),
    activation: setupNormalizers.normalizeManifestActivation(raw.activation),
    setup: setupNormalizers.normalizeManifestSetup(raw.setup),
    doctorContract,
    doctorHealthChecks: raw.doctorHealthChecks === true ? true : undefined,
    sessionRouteStateOwners:
      raw.sessionRouteStateOwners === undefined
        ? undefined
        : coerceDoctorSessionRouteStateOwners(raw.sessionRouteStateOwners),
    qaRunners: setupNormalizers.normalizeManifestQaRunners(raw.qaRunners),
  };
  const dashboardResult = setupNormalizers.normalizeManifestDashboard(raw.dashboard);
  if (!dashboardResult.ok) {
    return fail(`invalid plugin manifest dashboard: ${dashboardResult.error}`);
  }
  const uiCapabilities = validatePluginUiCapabilities(raw.uiCapabilities);
  const controlUiResult = loadPluginControlUiDeclaration({
    rootDir,
    controlUi: raw.controlUi,
    channels,
    rejectHardlinks,
    rootRealPath,
  });
  if (!controlUiResult.ok) {
    return fail(`invalid plugin manifest controlUi: ${controlUiResult.error}`);
  }

  const themesResult = normalizeManifestThemes(raw.themes, id, file.contents.toString("utf8"));
  if (!themesResult.ok) {
    return fail(`invalid plugin manifest themes: ${themesResult.error}`);
  }

  return cacheResult({
    ok: true,
    // Older readers ignored this advisory field; invalid display metadata must
    // not prevent an installed plugin from loading after an OpenClaw update.
    ...(!uiCapabilities.ok
      ? { warnings: [`ignoring invalid plugin manifest uiCapabilities: ${uiCapabilities.error}`] }
      : {}),
    manifest: {
      ...manifestBeforeDashboard,
      dashboard: dashboardResult.dashboard,
      controlUi: controlUiResult.value,
      ...(uiCapabilities.ok && uiCapabilities.capabilities !== undefined
        ? { uiCapabilities: uiCapabilities.capabilities }
        : {}),
      themes: themesResult.themes,
      mcpServers: capabilityNormalizers.normalizeManifestMcpServers(raw.mcpServers),
      skills: normalizeTrimmedStringList(raw.skills),
      name: normalizeOptionalString(raw.name),
      description: normalizeOptionalString(raw.description),
      catalog: capabilityNormalizers.normalizeManifestCatalog(raw.catalog),
      version: normalizeOptionalString(raw.version),
      uiHints: setupNormalizers.normalizeConfigUiHints(raw.uiHints),
      configGroups: normalizeConfigGroups(raw.configGroups, configSchema),
      contracts,
      decisionModels: capabilityNormalizers.normalizeManifestDecisionModels(
        raw.decisionModels,
        contracts?.decisionProviders,
      ),
      transcriptSources: capabilityNormalizers.normalizeManifestTranscriptSources(
        raw.transcriptSources,
        contracts?.transcriptSourceProviders,
      ),
      mediaUnderstandingProviderMetadata:
        capabilityNormalizers.normalizeMediaUnderstandingProviderMetadata(
          raw.mediaUnderstandingProviderMetadata,
        ),
      imageGenerationProviderMetadata: capabilityNormalizers.normalizeCapabilityProviderMetadata(
        raw.imageGenerationProviderMetadata,
      ),
      videoGenerationProviderMetadata: capabilityNormalizers.normalizeCapabilityProviderMetadata(
        raw.videoGenerationProviderMetadata,
      ),
      musicGenerationProviderMetadata: capabilityNormalizers.normalizeCapabilityProviderMetadata(
        raw.musicGenerationProviderMetadata,
      ),
      toolMetadata: capabilityNormalizers.normalizePluginToolMetadata(raw.toolMetadata),
      configContracts: capabilityNormalizers.normalizeManifestConfigContracts(raw.configContracts),
      channelConfigs: setupNormalizers.normalizeChannelConfigs(raw.channelConfigs),
    },
    manifestPath,
  });
}
