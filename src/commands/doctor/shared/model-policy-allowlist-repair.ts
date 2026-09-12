import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { listAgentEntries } from "../../../agents/agent-scope-config.js";
import { resolveAgentEffectiveModelPrimary } from "../../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import {
  resolveLogicalModelCatalogEntryState,
  resolveLogicalVisibleModelCatalog,
} from "../../../agents/model-catalog-visibility.js";
import type { ModelCatalogEntry } from "../../../agents/model-catalog.types.js";
import { resolveConfiguredModelPolicyAllow } from "../../../agents/model-selection-shared.js";
import { resolveConfiguredModelRef } from "../../../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../../../agents/model-visibility-policy.js";
import { resolveAgentModelPrimaryValue } from "../../../config/model-input.js";
import {
  hasExplicitModelPolicyAllow,
  hasModelPolicyAllowlistMigrationMarker,
} from "../../../config/model-policy-allowlist-migration.js";
import {
  createModelPolicyRefValidator,
  parseModelPolicyWildcardRef,
} from "../../../config/model-policy-ref.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { DoctorConfigMutationResult } from "./config-mutation-state.js";

const ALLOW_PATH = "agents.defaults.modelPolicy.allow";

function modelPolicyInspectionConfig(config: OpenClawConfig): OpenClawConfig {
  const inspectionConfig = structuredClone(config);
  for (const agent of [inspectionConfig.agents?.defaults, ...listAgentEntries(inspectionConfig)]) {
    if (Array.isArray(agent?.modelPolicy?.allow)) {
      agent.modelPolicy.allow = agent.modelPolicy.allow.filter(
        (entry) => typeof entry === "string",
      );
    }
  }
  return inspectionConfig;
}

export async function prepareDoctorModelPolicyAllowlist(params: {
  config: OpenClawConfig;
  sourceConfig: unknown;
}): Promise<DoctorConfigMutationResult & { warnings: string[] }> {
  const { config } = params;
  const inspectionConfig = modelPolicyInspectionConfig(config);
  const policyRefs = [undefined, ...listAgentEntries(config).map((agent) => agent.id)].flatMap(
    (agentId) => resolveConfiguredModelPolicyAllow({ cfg: inspectionConfig, agentId }).refs,
  );
  if (policyRefs.length === 0) {
    return { config, changes: [], warnings: [] };
  }
  const { withPreparedModelCatalogOwner, loadPreparedModelCatalogSnapshot } =
    await import("../../../agents/prepared-model-catalog.js");
  const { createModelCatalogDecisions } =
    await import("../../../agents/model-catalog-decisions.js");
  const { getPreparedModelRuntimeAuthStore, getPreparedModelRuntimeAuthMaterializations } =
    await import("../../../agents/prepared-model-runtime-auth.js");
  const { openAIModelCatalogRoutePolicy } = await import("../../../agents/openai-model-routes.js");
  const { PreparedModelRuntimePublicationSupersededError } =
    await import("../../../agents/prepared-model-runtime.errors.js");
  const { AuthProfileMigrationRequiredError } =
    await import("../../../agents/auth-profiles/legacy-source-diagnostic.js");
  const { isManifestPluginAvailableForControlPlane } =
    await import("../../../plugins/manifest-contract-eligibility.js");
  return withPreparedModelCatalogOwner(
    { config: inspectionConfig, readOnly: true },
    async (owner) => {
      const authStore = getPreparedModelRuntimeAuthStore(owner);
      const agentId = owner.catalogOwner?.agentId;
      if (!authStore || !agentId) {
        throw new Error("Model catalog owner omitted its auth store or agent scope");
      }
      const providers = new Set([
        ...owner.modelCatalog.entries.map((row) => row.provider),
        ...Object.keys(config.models?.providers ?? {}),
        ...owner.metadataSnapshot.plugins.flatMap((plugin) => plugin.providers),
      ]);
      for (const provider of providers) {
        const owners = owner.metadataSnapshot.plugins.filter((plugin) =>
          plugin.providers.includes(provider),
        );
        if (
          owners.length > 0 &&
          !owners.some((plugin) =>
            isManifestPluginAvailableForControlPlane({
              snapshot: owner.metadataSnapshot,
              plugin,
              config,
            }),
          )
        ) {
          providers.delete(provider);
        }
      }
      const providerDiscoveryProviderIds = [
        ...new Set([
          ...owner.modelCatalog.entries.map((row) => row.provider),
          ...Object.keys(owner.authModes),
          ...Object.keys(config.models?.providers ?? {}),
          ...policyRefs.flatMap((value) => {
            const ref = parseModelCatalogRef(value);
            return ref ? [ref.provider] : [];
          }),
        ]),
      ].filter((provider) => providers.has(provider));
      // A fresh Doctor process has no published inventory. Inspect through the catalog's
      // read-only discovery route instead of treating its passive snapshot as complete.
      const catalog =
        config.models?.mode === "replace"
          ? owner.modelCatalog
          : await loadPreparedModelCatalogSnapshot({
              config: inspectionConfig,
              agentId,
              agentDir: owner.agentDir,
              workspaceDir: owner.workspaceDir,
              readOnly: true,
              providerDiscoveryProviderIds,
              scopedLiveProviderDiscovery: true,
            });
      if (!owner.isCurrent()) {
        throw new PreparedModelRuntimePublicationSupersededError(
          "Model catalog changed while checking the allow list",
        );
      }
      if (
        catalog.authoritative === false ||
        catalog.refreshFailed ||
        catalog.pendingProviders?.length ||
        catalog.providerOutcomes?.some((outcome) => outcome.status !== "ready")
      ) {
        return {
          config,
          changes: [],
          warnings: [
            "Model allow-list inspection is deferred because provider model discovery did not complete. Check provider connectivity and credentials, then run openclaw doctor again.",
          ],
        };
      }
      const decisions = createModelCatalogDecisions({
        cfg: inspectionConfig,
        agentId,
        agentDir: owner.agentDir,
        workspaceDir: owner.workspaceDir,
        snapshot: catalog,
        metadataSnapshot: owner.metadataSnapshot,
        preparedAuthStore: authStore,
        preparedRuntimeAuthModes: owner.authModes,
        preparedRuntimeAuthMaterializations: getPreparedModelRuntimeAuthMaterializations(owner),
        pluginRegistry: owner.pluginRegistry,
        observationConfig: owner.observationConfig,
        isCurrent: owner.isCurrent,
      });
      const { allowList } = await resolveLogicalVisibleModelCatalog({
        cfg: inspectionConfig,
        catalog: catalog.entries,
        defaultProvider: DEFAULT_PROVIDER,
        routePolicy: openAIModelCatalogRoutePolicy,
        routeVariants: catalog.routeVariants,
        evaluateEntry: async (entry, variants) =>
          resolveLogicalModelCatalogEntryState({
            evaluation: decisions.evaluateNative(
              entry,
              await decisions.evaluateEntry(entry, variants),
            ),
            provider: entry.provider,
            routePolicy: openAIModelCatalogRoutePolicy,
          }),
      });
      const result = inspectModelPolicyAllowlist({
        config,
        catalog: catalog.entries,
        enabledProviders: providers,
        sourceConfig: params.sourceConfig,
        hiddenCount: allowList?.hiddenCount ?? 0,
      });
      if (!decisions.isCurrent()) {
        throw new PreparedModelRuntimePublicationSupersededError(
          "Model catalog changed while checking the allow list",
        );
      }
      return result;
    },
  ).catch((error: unknown) => {
    if (!(error instanceof AuthProfileMigrationRequiredError)) {
      throw error;
    }
    return {
      config,
      changes: [],
      warnings: [
        `Model allow-list inspection is deferred until legacy credentials are migrated. ${error.message}`,
      ],
    };
  });
}

/** Migration metadata identifies an offer; only the Doctor caller can obtain consent. */
function repairUpgradeGeneratedModelAllowlist(
  config: OpenClawConfig,
  sourceConfig: unknown = config,
): DoctorConfigMutationResult {
  const allow = config.agents?.defaults?.modelPolicy?.allow;
  if (!hasModelPolicyAllowlistMigrationMarker(sourceConfig) || !Array.isArray(allow)) {
    return { config, changes: [] };
  }
  const validRef = createModelPolicyRefValidator();
  const providers = new Set<string>();
  let changed = false;
  let hasExactEntry = false;
  const next = allow.flatMap((entry) => {
    if (typeof entry !== "string" || !validRef(entry)) {
      return [entry];
    }
    const wildcard = parseModelPolicyWildcardRef(entry);
    const ref = parseModelCatalogRef(entry);
    if (!ref || (wildcard && wildcard.key !== `${wildcard.provider}/*`)) {
      return [entry];
    }
    hasExactEntry ||= !wildcard;
    const replacement = `${ref.provider}/*`;
    changed ||= entry !== replacement || providers.has(replacement);
    if (providers.has(replacement)) {
      return [];
    }
    providers.add(replacement);
    return [replacement];
  });
  return hasExactEntry && changed
    ? {
        config: {
          ...config,
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents?.defaults,
              modelPolicy: { ...config.agents?.defaults?.modelPolicy, allow: next },
            },
          },
        },
        changes: [
          `Change ${ALLOW_PATH} from ${JSON.stringify(allow)} to ${JSON.stringify(next)}. This permits all current and future models from these providers.`,
        ],
      }
    : { config, changes: [] };
}

function inspectModelPolicyAllowlist(params: {
  config: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  enabledProviders: ReadonlySet<string>;
  sourceConfig: unknown;
  hiddenCount: number;
}): DoctorConfigMutationResult & { warnings: string[] } {
  const { config, catalog } = params;
  const allow = config.agents?.defaults?.modelPolicy?.allow;
  const unchanged = { config, changes: [], warnings: [] };
  const warnings: string[] = [];
  // Malformed entries remain in the repair candidate; policy inspection consumes only strings.
  const inspectionConfig = modelPolicyInspectionConfig(config);
  const defaultPolicy = resolveConfiguredModelPolicyAllow({ cfg: inspectionConfig });
  const scopes = [
    {
      allow: defaultPolicy.refs,
      path: defaultPolicy.configPath ?? ALLOW_PATH,
      agentId: undefined,
      primary: resolveAgentModelPrimaryValue(config.agents?.defaults?.model),
    },
    ...listAgentEntries(config)
      .filter(
        (agent) =>
          resolveAgentModelPrimaryValue(agent.model) !== undefined ||
          hasExplicitModelPolicyAllow(agent.modelPolicy),
      )
      .map((agent) => {
        const policy = resolveConfiguredModelPolicyAllow({
          cfg: inspectionConfig,
          agentId: agent.id,
        });
        return {
          allow: hasExplicitModelPolicyAllow(agent.modelPolicy) ? policy.refs : [],
          path: policy.repairConfigPath.replace("entries.*", `entries.${agent.id}`),
          agentId: agent.id,
          primary: resolveAgentEffectiveModelPrimary(config, agent.id),
        };
      }),
  ];
  for (const scope of scopes) {
    for (const entry of Array.isArray(scope.allow) ? scope.allow : []) {
      if (typeof entry !== "string") {
        continue;
      }
      const ref = parseModelCatalogRef(entry);
      if (!ref) {
        continue;
      }
      if (!params.enabledProviders.has(ref.provider)) {
        warnings.push(
          `${scope.path}: ${entry} uses a provider that is not enabled. Enable ${ref.provider} or remove this entry.`,
        );
      } else if (
        !parseModelPolicyWildcardRef(entry) &&
        !catalog.some((row) => row.provider === ref.provider && row.id === ref.modelId)
      ) {
        warnings.push(
          `${scope.path}: ${entry} is absent from the model catalog. Replace it with an available model or ${ref.provider}/*, or remove this entry.`,
        );
      }
    }
    if (scope.primary) {
      const policy = createModelVisibilityPolicy({
        cfg: inspectionConfig,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
        agentId: scope.agentId,
      });
      const selected = resolveConfiguredModelRef({
        cfg: inspectionConfig,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
        agentId: scope.agentId,
      });
      if (!policy.allowsByList(selected)) {
        const path = policy.allowRepairConfigPath.replace("entries.*", `entries.${scope.agentId}`);
        const model = `${selected.provider}/${selected.model}`;
        warnings.push(
          `Your primary model ${model} is not in your allow list${scope.agentId ? ` for agent ${scope.agentId}` : ""}. It remains usable as Default. Add "${model}" or "${selected.provider}/*" to ${path}.`,
        );
      }
    }
  }
  if (!Array.isArray(allow) || !allow.length) {
    return { ...unchanged, warnings };
  }
  const mutation = repairUpgradeGeneratedModelAllowlist(config, params.sourceConfig);
  if (mutation.changes.length === 0) {
    return { ...unchanged, warnings };
  }
  const hiddenCount = params.hiddenCount;
  if (hiddenCount === 0) {
    return { ...unchanged, warnings };
  }
  warnings.push(
    `${ALLOW_PATH} has migration metadata and hides ${hiddenCount} catalog models. Run openclaw doctor in an interactive terminal to review a provider/* offer. The metadata does not show whether you later changed this list.`,
  );
  return { ...mutation, warnings };
}
