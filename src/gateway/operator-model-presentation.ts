import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
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
import { isTranscriptOnlyOpenClawAssistantModel } from "../shared/transcript-only-openclaw-assistant.js";
import { resolveOperatorRolePolicy } from "./operator-role-policy.js";
import type { ChatMetadataResult } from "./server-methods/chat-metadata-contract.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { getSessionDefaults } from "./session-utils-model.js";
import type { GatewaySessionRow, GatewaySessionsDefaults } from "./session-utils.types.js";

type HistoricalModelFields = {
  model?: unknown;
  modelProvider?: unknown;
  activeModel?: unknown;
  activeModelProvider?: unknown;
  contextBudgetStatus?: unknown;
};

/** History and startup share a final projection without changing any persisted session facts. */
export function projectOperatorModelRead<
  T extends {
    defaults?: GatewaySessionsDefaults;
    metadata?: ChatMetadataResult;
    sessionInfo?: GatewaySessionRow;
    kind?: string;
    messages?: unknown[];
    message?: unknown;
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
  const presentation = prepareOperatorModelPresentation({
    cfg,
    policyConfig: scope.context.getCommittedRuntimeConfig?.() ?? cfg,
    client: scope.client,
  });
  if (!presentation) {
    return result;
  }
  const policy =
    result.defaults || result.metadata
      ? presentation.forAgent(scope.agentId, scope.catalog)
      : undefined;
  return {
    ...result,
    ...(result.defaults && policy ? { defaults: policy.defaults(result.defaults) } : {}),
    ...(result.metadata && policy ? { metadata: policy.metadata(result.metadata) } : {}),
    ...(result.sessionInfo ? { sessionInfo: presentation.session(result.sessionInfo) } : {}),
    ...(result.messages
      ? {
          messages: result.messages.map(
            result.kind === "delta" ? presentation.deltaMessage : presentation.message,
          ),
        }
      : {}),
    ...(Object.hasOwn(result, "message") ? { message: presentation.message(result.message) } : {}),
  };
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
  const hidden = (provider: unknown, model: unknown) =>
    (provider != null || model != null) &&
    (typeof provider !== "string" ||
      typeof model !== "string" ||
      !policy.allows({ provider, model }));
  const projectSession = <T extends HistoricalModelFields>(row: T): T => {
    const hideModel = hidden(row.modelProvider, row.model);
    const hideActiveModel = hidden(row.activeModelProvider, row.activeModel);
    const budget = asOptionalRecord(row.contextBudgetStatus);
    const hideBudget = budget && hidden(budget.provider, budget.model);
    if (!hideModel && !hideActiveModel && !hideBudget) {
      return row;
    }
    const projected = { ...row };
    // Nulls clear merge-event state; omit identifiers without replacing those clearing facts.
    for (const field of ["modelProvider", "model"] as const) {
      if (hideModel && projected[field] != null) {
        delete projected[field];
      }
    }
    for (const field of ["activeModelProvider", "activeModel"] as const) {
      if (hideActiveModel && projected[field] != null) {
        delete projected[field];
      }
    }
    if (hideBudget) {
      delete projected.contextBudgetStatus;
    }
    return projected;
  };
  const projectMessage = (value: unknown): unknown => {
    const message = asOptionalRecord(value);
    if (
      !message ||
      message.role !== "assistant" ||
      isTranscriptOnlyOpenClawAssistantModel(message.provider, message.model) ||
      !hidden(message.provider, message.model)
    ) {
      return value;
    }
    const projected = { ...message };
    for (const field of ["provider", "model"] as const) {
      if (projected[field] != null) {
        delete projected[field];
      }
    }
    return projected;
  };

  return {
    session: projectSession,
    message: projectMessage,
    deltaMessage(this: void, value: unknown): unknown {
      const envelope = asOptionalRecord(value);
      if (!envelope) {
        return value;
      }
      const session = asOptionalRecord(envelope.session);
      // Delta copies were budgeted before the last readiness await. Recheck all three
      // concrete disclosure sites at publication; removing fields only shrinks that budget.
      return {
        ...projectSession(envelope),
        ...(session ? { session: projectSession(session) } : {}),
        ...(Object.hasOwn(envelope, "message")
          ? { message: projectMessage(envelope.message) }
          : {}),
      };
    },
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
