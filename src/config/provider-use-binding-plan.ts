/** Shared read-only provider binding upgrade plan for config loading and Doctor. */
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import {
  listCandidateAuthProfileStores,
  loadCandidateAuthProfileStore,
} from "../agents/auth-profiles/candidate-stores.js";
import { loadPersistedAuthProfileStoreAtDatabasePath } from "../agents/auth-profiles/persisted.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  collectConfiguredProviderUseSelections,
  type ConfiguredProviderUseSelection,
} from "../agents/configured-provider-selection-ids.js";
import { resolveProviderAuthAliasMap } from "../agents/provider-auth-aliases.js";
import {
  isGenericProviderCredentialEnvVar,
  resolveProviderUseAdmission,
  resolveProviderUseBindingCredentialPolicy,
  providerUseBindingConflictsWithAccount,
} from "../agents/provider-model-auth-source-plan.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  resolveLegacyMigrationSourceKey,
} from "../infra/state-migrations.receipts.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  resolveProviderBindingEnvVarCandidates,
  type ProviderBindingEnvVarCandidates,
} from "../secrets/provider-env-vars.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  resolveConfigProviderUseBindings,
  setConfigProviderUseBindings,
} from "./resolution-facts.js";
import { resolveResetPreservedSelection } from "./sessions/reset-preserved-selection.js";
import { scanDoctorSessionEntriesTolerant } from "./sessions/session-accessor.sqlite-canonical-inventory.js";
import { listExistingAgentDatabaseTargets } from "./sessions/targets-existing.js";
import type { ModelProviderConfigInput } from "./types.models.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { parseEnvTemplateSecretRef, type SecretRef } from "./types.secrets.js";
import { validateConfigObjectRaw } from "./validation-core.js";

export const PROVIDER_USE_BINDING_MIGRATION = "selected-shared-provider-bindings:v1";
export const PROVIDER_USE_BINDING_SELECTION_VERSION = 2;
const CHAIN_PROVIDERS = new Set([
  "amazon-bedrock",
  "amazon-bedrock-mantle",
  "anthropic-vertex",
  "google-vertex",
]);
export type ProviderUseBindingMigrationBindings = Record<string, { apiKey?: SecretRef }>;
const DEFERRED =
  'Could not read provider upgrade state; shared-key bindings were left unchanged. Rerun "openclaw doctor --fix".';

/** Runtime projection shares Doctor's transform but neither writes config nor completes receipts. */
export function applyProviderUseBindingsToRuntime(
  params: Parameters<typeof prepareProviderUseBindingMigration>[0] & {
    runtimeConfig: OpenClawConfig;
  },
): { config: OpenClawConfig; warnings: string[] } {
  const migration = prepareProviderUseBindingMigration(params);
  setConfigProviderUseBindings(params.runtimeConfig, migration.bindings ?? {});
  const warnings = [...(migration.warnings ?? [])];
  const entries = Object.entries(migration.bindings ?? {}).map(([id, binding]) =>
    binding.apiKey
      ? `models.providers.${id}.apiKey = ${JSON.stringify(binding.apiKey)}`
      : `models.providers.${id} = {}`,
  );
  if (entries.length > 0) {
    warnings.push(
      `Selected provider bindings are active in memory only. Run "openclaw doctor --fix" or update the managed config ${params.configPath}: ${entries.join("; ")}.`,
    );
  }
  return { config: resolveConfigProviderUseBindings(params.runtimeConfig), warnings };
}

/** Preserve selected shared-key routes once; ordinary runtime selection never creates bindings. */
export function prepareProviderUseBindingMigration(params: {
  config: OpenClawConfig;
  configPath: string;
  env: NodeJS.ProcessEnv;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  loadManifestRegistry?: () => Pick<PluginManifestRegistry, "plugins">;
}): {
  config: OpenClawConfig;
  changes: string[];
  pending: boolean;
  warnings?: string[];
  unsetPaths?: string[][];
  bindings?: ProviderUseBindingMigrationBindings;
} {
  const { config, configPath, env } = params;
  const unchanged = { config, changes: [], pending: false };
  // Doctor retains invalid source values until its config validation step.
  const envProvider: unknown = config.secrets?.defaults?.env;
  if (envProvider !== undefined && typeof envProvider !== "string") {
    return unchanged;
  }
  if (config.models !== undefined && !isRecord(config.models)) {
    return unchanged;
  }
  if (config.models?.providers !== undefined && !isRecord(config.models.providers)) {
    return unchanged;
  }
  const sourceKey = resolveLegacyMigrationSourceKey(PROVIDER_USE_BINDING_MIGRATION, configPath);
  const sessionSelections: Array<{ agentId: string; model: string }> = [];
  let configuredSelections: ConfiguredProviderUseSelection[];
  let narrowReceipt = false;
  let direct: ProviderBindingEnvVarCandidates;
  let envCandidateMap: Readonly<Record<string, readonly string[]>>;
  let credentialPolicy: ReturnType<typeof resolveProviderUseBindingCredentialPolicy>;
  let aliasMap: Readonly<Record<string, string>>;
  const authScopes = new Map<string, { agentDir: string; store: AuthProfileStore }>();
  const accountScopes: Array<{ owner: string; store: AuthProfileStore }> = [];
  // Receipts and session pins are external state. A failed read must not turn an
  // incomplete selection snapshot into a completed upgrade or prevent startup.
  try {
    const completed = withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => readLegacyMigrationReceiptFromDatabase(db, sourceKey),
      { env },
    );
    if (completed) {
      let report: unknown;
      try {
        report = JSON.parse(completed.reportJson);
      } catch {
        report = undefined;
      }
      if (
        isRecord(report) &&
        typeof report.selectionVersion === "number" &&
        report.selectionVersion >= PROVIDER_USE_BINDING_SELECTION_VERSION
      ) {
        return unchanged;
      }
      narrowReceipt = true;
    }
    configuredSelections = collectConfiguredProviderUseSelections({ config, env });
    const candidates = listCandidateAuthProfileStores({ cfg: config, env });
    const sharedStore = loadPersistedAuthProfileStoreAtDatabasePath(
      resolveOpenClawStateSqlitePath(env),
      "shared-state",
    );
    if (sharedStore) {
      accountScopes.push({ owner: "shared", store: sharedStore });
    }
    for (const candidate of candidates) {
      const store = loadCandidateAuthProfileStore(candidate);
      if (store) {
        accountScopes.push({ owner: candidate.agentId, store });
      }
    }
    let incompletePins = false;
    for (const target of listExistingAgentDatabaseTargets(config, env)) {
      scanDoctorSessionEntriesTolerant(
        { agentId: target.agentId, storePath: target.storePath, env },
        ({ entry, recoveredFromProjections }) => {
          if (recoveredFromProjections) {
            incompletePins = true;
            return;
          }
          const pin = resolveResetPreservedSelection({ entry });
          if (typeof pin.modelOverride === "string") {
            sessionSelections.push({
              agentId: target.agentId,
              model:
                pin.providerOverride && !pin.modelOverride.startsWith(`${pin.providerOverride}/`)
                  ? `${pin.providerOverride}/${pin.modelOverride}`
                  : pin.modelOverride,
            });
          }
        },
      );
    }
    if (incompletePins) {
      return { ...unchanged, warnings: [DEFERRED] };
    }
    if (configuredSelections.length === 0 && sessionSelections.length === 0) {
      return { ...unchanged, pending: true };
    }
    for (const agentId of new Set([
      ...listAgentIds(config),
      ...configuredSelections.map((selection) => selection.agentId),
      ...sessionSelections.map((selection) => selection.agentId),
    ])) {
      const agentDir = resolveAgentDir(config, agentId, env);
      authScopes.set(agentId, {
        agentDir,
        store: {
          version: 1,
          profiles: Object.assign(
            {},
            ...accountScopes
              .filter((scope) => scope.owner === "shared" || scope.owner === agentId)
              .map((scope) => scope.store.profiles),
          ),
        },
      });
    }
    const manifestRegistry = params.manifestRegistry ?? params.loadManifestRegistry?.();
    direct = resolveProviderBindingEnvVarCandidates({
      config,
      env,
      manifestPlugins: manifestRegistry?.plugins,
    });
    aliasMap = resolveProviderAuthAliasMap({
      config,
      env,
      includeUntrustedWorkspacePlugins: false,
      ...(manifestRegistry ? { metadataSnapshot: { plugins: manifestRegistry.plugins } } : {}),
    });
    credentialPolicy = resolveProviderUseBindingCredentialPolicy(direct, aliasMap);
    envCandidateMap = credentialPolicy.envCandidateMap;
  } catch {
    return { ...unchanged, warnings: [DEFERRED] };
  }
  const selectedProviders = new Map<string, Set<string>>();
  for (const agentId of authScopes.keys()) {
    selectedProviders.set(
      agentId,
      new Set(
        configuredSelections
          .filter(
            (selection) =>
              selection.agentId === agentId &&
              (!narrowReceipt ||
                !selection.previouslyCovered ||
                CHAIN_PROVIDERS.has(selection.provider)),
          )
          .map((selection) => selection.provider),
      ),
    );
  }
  const { manifestVariables } = credentialPolicy;
  const admissions = new Map(
    [...authScopes].map(([agentId, { store }]) => [
      agentId,
      resolveProviderUseAdmission({
        config,
        includeRuntimeBindings: false,
        env,
        providerEnvVars: direct,
        profiles: store.profiles,
      }),
    ]),
  );
  const providers: Record<string, ModelProviderConfigInput> = {};
  const bindings: ProviderUseBindingMigrationBindings = {};
  const changes: string[] = [];
  const warnings: string[] = [];
  const providerCandidates: Readonly<Record<string, readonly string[]>> = {
    ...Object.fromEntries([...CHAIN_PROVIDERS].map((provider) => [provider, []])),
    ...envCandidateMap,
  };
  for (const [identity, candidates] of Object.entries(providerCandidates)) {
    const provider = normalizeProviderId(identity);
    const chain = CHAIN_PROVIDERS.has(provider);
    const selectedAgents = [...selectedProviders]
      .filter(
        ([agentId, selected]) =>
          selected.has(provider) ||
          ((!narrowReceipt || chain) &&
            sessionSelections.some(
              (selection) =>
                selection.agentId === agentId &&
                normalizeProviderId(parseModelCatalogRef(selection.model)?.provider ?? "") ===
                  provider,
            )),
      )
      .map(([agentId]) => agentId);
    if (
      (!chain && !Object.hasOwn(direct, identity) && !Object.hasOwn(aliasMap, identity)) ||
      selectedAgents.length === 0
    ) {
      continue;
    }
    const sharedVariables = candidates.filter(
      (name) =>
        manifestVariables.has(name) &&
        !isGenericProviderCredentialEnvVar(name) &&
        Object.entries(envCandidateMap).some(
          ([sibling, names]) => normalizeProviderId(sibling) !== provider && names.includes(name),
        ),
    );
    if (!chain && sharedVariables.length === 0) {
      continue;
    }
    const missingAgents = selectedAgents.filter(
      (agentId) => !admissions.get(agentId)?.has(provider),
    );
    if (missingAgents.length === 0) {
      continue;
    }
    const accountOwners = new Set<string>();
    const conflictingProfiles = new Set<string>();
    for (const { owner, store } of accountScopes) {
      for (const [profileId, profile] of Object.entries(store.profiles)) {
        if (providerUseBindingConflictsWithAccount(provider, profile.provider, credentialPolicy)) {
          accountOwners.add(owner);
          conflictingProfiles.add(profileId);
        }
      }
    }
    if (conflictingProfiles.size > 0) {
      warnings.push(
        `Provider ${provider} was not migrated for agents ${missingAgents.join(", ")}: a global binding could replace an existing account for agents ${[...accountOwners].join(", ")} (profiles ${[...conflictingProfiles].join(", ")}). Bind the provider explicitly to the saved account, then rerun "openclaw doctor --fix".`,
      );
      continue;
    }
    const variable = sharedVariables.find((name) => env[name]?.trim());
    if (!chain && !variable) {
      warnings.push(
        `Could not evaluate the shared-key upgrade for provider ${provider}: ${sharedVariables.join(", ")} is not set. Rerun "openclaw doctor --fix" from the service environment or with a candidate variable set.`,
      );
      continue;
    }
    const apiKey =
      !chain && variable ? parseEnvTemplateSecretRef(`\${${variable}}`, envProvider) : null;
    if (!chain && !apiKey) {
      continue;
    }
    const binding = apiKey ? { apiKey } : {};
    providers[provider] = binding;
    bindings[provider] = binding;
    changes.push(
      chain
        ? `Declared selected provider ${provider} for its configured credential chain.`
        : `Bound selected provider ${provider} to ${variable} with an env SecretRef.`,
    );
  }
  if (changes.length === 0) {
    return {
      ...unchanged,
      pending: warnings.length === 0,
      ...(warnings.length ? { warnings } : {}),
    };
  }
  const validated = validateConfigObjectRaw({ models: { providers } }, { env });
  if (!validated.ok) {
    return {
      ...unchanged,
      warnings: ["Could not validate shared-key provider bindings; config was left unchanged."],
    };
  }
  return {
    config: {
      ...config,
      models: {
        ...config.models,
        providers: { ...config.models?.providers, ...validated.config.models?.providers },
      },
    },
    changes,
    bindings,
    pending: warnings.length === 0,
    ...(warnings.length ? { warnings } : {}),
    // Doctor consumes materialized config; its writer preserves the sparse source overlay.
    unsetPaths: Object.keys(providers).flatMap((provider) =>
      ["baseUrl", "models"].map((field) => ["models", "providers", provider, field]),
    ),
  };
}
