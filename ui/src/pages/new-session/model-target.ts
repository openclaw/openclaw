import type { GatewayAgentRow, ModelCatalogEntry, SessionsListResult } from "../../api/types.ts";
import {
  buildQualifiedChatModelValue,
  normalizeChatModelProviderId,
  resolvePreferredServerChatModelValue,
} from "../../lib/chat/model-ref.ts";
import {
  normalizeThinkingOptionValue,
  resolveThinkingProfileForSession,
  type ChatThinkingTarget,
} from "../../lib/chat/thinking.ts";

type DraftModelTarget = {
  entry?: ModelCatalogEntry;
  model: string;
  provider: string | null;
};

export function resolveDraftThinkingTarget(
  target: DraftModelTarget | null,
  agent?: GatewayAgentRow,
): ChatThinkingTarget {
  return {
    model: target?.model ?? agent?.model?.primary,
    modelProvider: target?.provider ?? undefined,
    agentRuntime: agent?.agentRuntime ?? target?.entry?.agentRuntime,
    thinkingLevels: agent?.thinkingLevels,
    thinkingOptions: agent?.thinkingOptions,
    thinkingDefault: agent?.thinkingDefault,
  };
}

export function resolveDraftModelTarget(
  model: string | null | undefined,
  provider: string | null | undefined,
  catalog: ModelCatalogEntry[],
): DraftModelTarget | null {
  const value = resolvePreferredServerChatModelValue(model, provider, catalog);
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase();
  const entry = catalog.find(
    (candidate) =>
      buildQualifiedChatModelValue(candidate.id, candidate.provider).toLowerCase() === normalized,
  );
  if (entry) {
    return {
      entry,
      model: entry.id,
      provider: normalizeChatModelProviderId(entry.provider) || null,
    };
  }
  const separator = value.indexOf("/");
  if (separator > 0) {
    return {
      model: value.slice(separator + 1),
      provider: normalizeChatModelProviderId(value.slice(0, separator)) || null,
    };
  }
  return {
    model: value,
    provider: normalizeChatModelProviderId(provider ?? "") || null,
  };
}

export function reconcileDraftModelSelection(params: {
  model: string;
  thinkingLevel: string;
  agent?: GatewayAgentRow;
  defaults?: SessionsListResult["defaults"];
  catalog: ModelCatalogEntry[];
}): { model: string; thinkingLevel: string; repaired: boolean } {
  const requestedModel = params.model.trim();
  const selectedTarget = requestedModel
    ? resolveDraftModelTarget(requestedModel, undefined, params.catalog)
    : null;
  if (requestedModel && (!selectedTarget?.entry || selectedTarget.entry.available === false)) {
    return { model: "", thinkingLevel: "", repaired: true };
  }
  const selected = selectedTarget?.entry
    ? buildQualifiedChatModelValue(selectedTarget.entry.id, selectedTarget.entry.provider)
    : "";
  if (!params.thinkingLevel) {
    return { model: selected, thinkingLevel: "", repaired: false };
  }
  const agentDefaultModel = params.agent?.model?.primary;
  const defaultTarget = selected
    ? null
    : resolveDraftModelTarget(
        agentDefaultModel ?? params.defaults?.model,
        agentDefaultModel ? undefined : params.defaults?.modelProvider,
        params.catalog,
      );
  const targetEntry = selectedTarget?.entry ?? defaultTarget?.entry;
  const thinkingProfile = resolveThinkingProfileForSession(
    resolveDraftThinkingTarget(
      selectedTarget ?? defaultTarget,
      selected ? undefined : params.agent,
    ),
    selected ? undefined : params.defaults,
    params.catalog,
  );
  const authoritativeLevels = thinkingProfile?.thinkingLevels;
  const normalizedThinking = normalizeThinkingOptionValue(params.thinkingLevel);
  const supported = authoritativeLevels?.some(
    (level) => normalizeThinkingOptionValue(level.id) === normalizedThinking,
  );
  if (targetEntry?.reasoning === false || (authoritativeLevels !== undefined && !supported)) {
    return { model: selected, thinkingLevel: "", repaired: true };
  }
  return { model: selected, thinkingLevel: params.thinkingLevel, repaired: false };
}
