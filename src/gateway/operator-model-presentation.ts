import type {
  AgentsListResult,
  ModelsListResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { modelKey } from "../agents/model-ref-shared.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import {
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import { createModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import {
  prepareOperatorModelPolicy,
  resolveOperatorModelDefault,
} from "../agents/operator-model-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveOperatorRolePolicy } from "./operator-role-policy.js";
import type { ChatMetadataResult } from "./server-methods/chat-metadata-contract.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { getSessionDefaults } from "./session-utils-model.js";
import type { GatewaySessionsDefaults } from "./session-utils.types.js";

/** History and startup share a final projection without changing any persisted session facts. */
export function projectOperatorModelRead<
  T extends {
    defaults?: GatewaySessionsDefaults;
    metadata?: ChatMetadataResult;
  },
>(
  scope: {
    context: Pick<GatewayRequestContext, "getRuntimeConfig" | "getCommittedRuntimeConfig">;
    client: GatewayClient | null;
    agentId: string;
    catalog?: ModelCatalogEntry[];
  },
  result: T,
): T {
  const cfg = scope.context.getRuntimeConfig();
  const policy = prepareOperatorModelPresentation({
    cfg,
    policyConfig: scope.context.getCommittedRuntimeConfig?.() ?? cfg,
    client: scope.client,
  })?.forAgent(scope.agentId, scope.catalog);
  return policy
    ? {
        ...result,
        ...(result.defaults ? { defaults: policy.defaults(result.defaults) } : {}),
        ...(result.metadata ? { metadata: policy.metadata(result.metadata) } : {}),
      }
    : result;
}

/** Build after read preparation; responses consume current role and prepared metadata together. */
export function prepareOperatorModelPresentation(params: {
  cfg: OpenClawConfig;
  policyConfig: OpenClawConfig;
  client: GatewayClient | null;
  metadataSnapshot?: PluginMetadataSnapshot;
}) {
  const { cfg, policyConfig, client } = params;
  // Catalog facts retain their runtime owner; permissions exclude tentative config activation.
  const modelPolicy = resolveOperatorRolePolicy(client, policyConfig)?.modelPolicy;
  if (!modelPolicy) {
    return undefined;
  }
  const metadataSnapshot = params.metadataSnapshot ?? getGatewayPluginMetadataSnapshot();
  const manifestPlugins = metadataSnapshot ?? [];
  const policy = prepareOperatorModelPolicy({
    cfg: policyConfig,
    policy: modelPolicy,
    manifestPlugins,
  });
  if (!policy) {
    return undefined;
  }
  const filterModels = <T extends { provider: string; id: string }>(models: T[]) =>
    models.filter((model) => policy.allows({ provider: model.provider, model: model.id }));

  return {
    forAgent(agentId: string, catalog: ModelCatalogEntry[] = []) {
      const normalization = {
        cfg,
        agentId,
        manifestPlugins,
        allowManifestNormalization: true,
        allowPluginNormalization: false,
      };
      const configuredDefault = resolveDefaultModelForAgent(normalization);
      const selection = { ...normalization, defaultProvider: configuredDefault.provider };
      let aliasIndex: ReturnType<typeof buildModelAliasIndex> | undefined;
      const allowedReference = (raw: string) => {
        const ref = resolveModelRefFromString({
          ...selection,
          raw,
          aliasIndex: (aliasIndex ??= buildModelAliasIndex(selection)),
        })?.ref;
        return ref && policy.allows(ref) ? ref : undefined;
      };
      let manualPolicy: ReturnType<typeof createModelVisibilityPolicy> | undefined;
      const defaultModel = resolveOperatorModelDefault({
        ...normalization,
        policy,
        model: configuredDefault,
        allows: (ref) =>
          (manualPolicy ??= createModelVisibilityPolicy({
            ...normalization,
            catalog,
            defaultProvider: configuredDefault.provider,
            defaultModel: configuredDefault,
          })).allows(ref),
      });
      const modelSelectionPolicy = {
        restricted: true as const,
        defaultModel: defaultModel ? modelKey(defaultModel.provider, defaultModel.model) : null,
      };
      const projectDefaults = (defaults: GatewaySessionsDefaults): GatewaySessionsDefaults => {
        if (!defaultModel) {
          return {
            model: null,
            modelProvider: null,
            contextTokens: null,
            ...(defaults.modelSelectionTarget
              ? { modelSelectionTarget: defaults.modelSelectionTarget }
              : {}),
          };
        }
        if (
          defaultModel.provider === defaults.modelProvider &&
          defaultModel.model === defaults.model
        ) {
          return defaults;
        }
        return {
          ...getSessionDefaults(cfg, catalog, {
            agentId,
            modelRef: defaultModel,
            metadataSnapshot,
            allowPluginNormalization: false,
            providerPolicySource: "active",
          }),
          ...(defaults.modelSelectionTarget
            ? { modelSelectionTarget: defaults.modelSelectionTarget }
            : {}),
        };
      };
      return {
        catalog(result: ModelsListResult): ModelsListResult {
          const models = filterModels(result.models);
          const decisionModels = result.decisionModels && filterModels(result.decisionModels);
          const utilityModel = result.defaultModels?.automaticUtilityModel
            ? allowedReference(result.defaultModels.automaticUtilityModel)
            : undefined;
          const visibleProviders = new Set(models.map(({ provider }) => provider));
          for (const model of decisionModels ?? []) {
            visibleProviders.add(model.provider);
          }
          if (defaultModel) {
            visibleProviders.add(defaultModel.provider);
          }
          if (utilityModel) {
            visibleProviders.add(utilityModel.provider);
          }
          // The account-selection owner already limits credential locators to this reader.
          const disclosedProfileId =
            result.accountSelection?.kind === "automatic"
              ? undefined
              : result.accountSelection?.authProfileId;
          const providerOutcomes = (result.providerOutcomes ?? []).filter(
            ({ provider, profileId }) =>
              visibleProviders.has(provider) && (!profileId || profileId === disclosedProfileId),
          );
          return {
            ...result,
            models,
            modelSelectionPolicy,
            pendingProviders: (result.pendingProviders ?? []).filter((provider) =>
              visibleProviders.has(provider),
            ),
            providerOutcomes,
            refreshFailed:
              result.refreshFailed === true &&
              providerOutcomes.some(({ status }) => status !== "ready"),
            ...(decisionModels ? { decisionModels } : {}),
            ...(result.defaultModels
              ? {
                  defaultModels: {
                    automaticUtilityModel: utilityModel
                      ? result.defaultModels.automaticUtilityModel
                      : null,
                  },
                }
              : {}),
          };
        },
        metadata(result: ChatMetadataResult): ChatMetadataResult {
          return {
            ...result,
            ...(result.models ? { models: filterModels(result.models) } : {}),
            modelSelectionPolicy,
          };
        },
        defaults: projectDefaults,
        agent(row: AgentsListResult["agents"][number]): AgentsListResult["agents"][number] {
          const {
            model: _model,
            utilityModel,
            agentRuntime: _runtime,
            thinkingLevels: _levels,
            thinkingOptions: _options,
            thinkingDefault: _thinking,
            ...identity
          } = row;
          const defaults = projectDefaults({
            model: null,
            modelProvider: null,
            contextTokens: null,
          });
          return {
            ...identity,
            model: {
              ...(modelSelectionPolicy.defaultModel
                ? { primary: modelSelectionPolicy.defaultModel }
                : {}),
              ...(row.model?.fallbacks
                ? { fallbacks: row.model.fallbacks.filter((ref) => allowedReference(ref)) }
                : {}),
            },
            ...(utilityModel && allowedReference(utilityModel) ? { utilityModel } : {}),
            agentRuntime: defaults.agentRuntime,
            thinkingLevels: defaults.thinkingLevels,
            thinkingOptions: defaults.thinkingOptions,
            thinkingDefault: defaults.thinkingDefault,
          };
        },
      };
    },
  };
}
