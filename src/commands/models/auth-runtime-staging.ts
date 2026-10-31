import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
} from "../../agents/agent-runtime-id.js";
import { normalizeProviderId } from "../../agents/model-ref-shared.js";
import { normalizeAgentModelRefForConfig } from "../../config/model-input.js";
import { resolveConsentAgentKey } from "../../config/native-runtime-consent.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderAuthResult } from "../../plugins/types.js";

/**
 * Shapes a provider login result for persistence, staging the per-agent model
 * runtime policy a harness-owned login declares (see the comments below).
 */
export function resolveLoginConnectionResult(params: {
  result: ProviderAuthResult;
  config: OpenClawConfig;
  agentId: string;
  providerId: string;
  ownerPluginId?: string;
  credentialOnly?: boolean;
}): { connectionResult: ProviderAuthResult; stagesRuntimePolicy: boolean } {
  // A login may declare the runtime that must serve its default model (for
  // example a harness-owned subscription sign-in). Guided setup stages that
  // as per-agent model runtime policy; every other login path (chat, gateway
  // wizard, CLI) must stage the same policy or the signed-in model keeps
  // resolving to the default API runtime. A login may only pin its own
  // provider's models, and the entry key must match the authored agent key
  // (mixed-case keys would otherwise create a rejected duplicate).
  const stagedAgentRuntimeId = normalizeOptionalAgentRuntimeId(params.result.agentRuntimeId);
  const stagedDefaultModelCandidate = params.result.defaultModel
    ? normalizeAgentModelRefForConfig(params.result.defaultModel)
    : undefined;
  const stagedDefaultModel =
    stagedDefaultModelCandidate &&
    normalizeProviderId(stagedDefaultModelCandidate.split("/")[0] ?? "") ===
      normalizeProviderId(params.providerId)
      ? stagedDefaultModelCandidate
      : undefined;
  // "openclaw" is the built-in runtime (isDefaultAgentRuntimeId covers the
  // auto/default sentinels, not this id); staging it would only pin noise.
  const stagedAgentKey = resolveConsentAgentKey(params.config, params.agentId);
  const stagedRuntimePatch =
    stagedAgentRuntimeId &&
    stagedAgentRuntimeId !== "openclaw" &&
    !isDefaultAgentRuntimeId(stagedAgentRuntimeId) &&
    stagedDefaultModel
      ? {
          agents: {
            entries: {
              [stagedAgentKey]: {
                models: {
                  [stagedDefaultModel]: { agentRuntime: { id: stagedAgentRuntimeId } },
                },
              },
            },
          },
        }
      : undefined;
  // Harness-owned logins reached the credential-only persistence path without
  // declaring credential-only semantics, so (like guided setup) keep only the
  // login's own plugin and runtime enablement entries from their patch.
  const stagedPluginsPatch =
    stagedRuntimePatch && params.result.configPatch?.plugins?.entries
      ? {
          plugins: {
            entries: Object.fromEntries(
              Object.entries(params.result.configPatch.plugins.entries).filter(
                ([pluginId]) =>
                  pluginId === stagedAgentRuntimeId ||
                  pluginId === params.providerId ||
                  pluginId === params.ownerPluginId,
              ),
            ),
          },
        }
      : undefined;
  // When staging (harness-owned login), narrow the provider-catalog slice to
  // this provider only, mirroring guided setup's staged scope.
  const stagedProviderPatch =
    stagedRuntimePatch && params.result.configPatch?.models?.providers
      ? {
          models: {
            providers: Object.fromEntries(
              Object.entries(params.result.configPatch.models.providers).filter(
                ([providerId]) =>
                  normalizeProviderId(providerId) === normalizeProviderId(params.providerId),
              ),
            ),
          },
        }
      : undefined;
  const connectionResult: ProviderAuthResult = params.credentialOnly
    ? {
        profiles: params.result.profiles,
        notes: params.result.notes,
        // Only a staged (harness-owned) result keeps its declared model so
        // runtime-plugin repair sees the same facts as a guided login.
        ...(stagedRuntimePatch && params.result.defaultModel
          ? { defaultModel: params.result.defaultModel }
          : {}),
        ...(params.result.configPatch || stagedRuntimePatch
          ? {
              configPatch: {
                ...stagedRuntimePatch,
                ...(stagedProviderPatch ??
                  (params.result.configPatch?.models?.providers
                    ? { models: { providers: params.result.configPatch.models.providers } }
                    : {})),
                ...(stagedRuntimePatch
                  ? (stagedPluginsPatch ?? {})
                  : params.result.configPatch?.plugins
                    ? { plugins: params.result.configPatch.plugins }
                    : {}),
              },
            }
          : {}),
      }
    : stagedRuntimePatch
      ? {
          ...params.result,
          configPatch: {
            ...params.result.configPatch,
            agents: {
              ...params.result.configPatch?.agents,
              entries: Object.fromEntries(
                Object.entries({
                  ...params.result.configPatch?.agents?.entries,
                  ...stagedRuntimePatch.agents.entries,
                }).map(([agentKey, agentEntry]) => {
                  const stagedModels = stagedRuntimePatch.agents.entries[stagedAgentKey]?.models;
                  return [
                    agentKey,
                    agentKey === stagedAgentKey && stagedModels
                      ? { ...agentEntry, models: { ...agentEntry?.models, ...stagedModels } }
                      : agentEntry,
                  ];
                }),
              ),
            },
          },
        }
      : params.result;
  return { connectionResult, stagesRuntimePolicy: stagedRuntimePatch !== undefined };
}
