import type { AppViewState } from "./app-view-state.ts";
import {
  buildCatalogDisplayLookup,
  buildChatModelOptionFromLookup,
  formatCatalogChatModelDisplayFromLookup,
  normalizeChatModelOverrideValue,
  resolvePreferredServerChatModelValue,
} from "./chat-model-ref.ts";
import {
  formatControlDirectorPrimaryModelDisplay,
  isControlDirectorAgentId,
  isControlDirectorPrimaryModelRef,
  resolveControlDirectorPrimaryModelValue,
} from "./control-director-model.ts";
import { pushUniqueTrimmedSelectOption } from "./select-options.ts";
import { resolveAgentIdFromSessionKey } from "./session-key.ts";
import type { ModelCatalogEntry } from "./types.ts";

type ChatModelSelectStateInput = Pick<
  AppViewState,
  "sessionKey" | "chatModelOverrides" | "chatModelCatalog" | "sessionsResult"
>;

export type ChatModelSelectOption = {
  value: string;
  label: string;
};

export type ChatModelSelectState = {
  currentOverride: string;
  defaultModel: string;
  defaultDisplay: string;
  defaultLabel: string;
  options: ChatModelSelectOption[];
};

function resolveActiveSessionRow(state: ChatModelSelectStateInput) {
  return state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
}

function isControlDirectorSession(state: ChatModelSelectStateInput): boolean {
  return isControlDirectorAgentId(resolveAgentIdFromSessionKey(state.sessionKey));
}

export function resolveChatModelOverrideValue(state: ChatModelSelectStateInput): string {
  const catalog = state.chatModelCatalog ?? [];
  const controlDirector = isControlDirectorSession(state);

  // Prefer the local cache — it reflects in-flight patches before sessionsResult refreshes.
  const cached = state.chatModelOverrides[state.sessionKey];
  if (cached) {
    const cachedValue = normalizeChatModelOverrideValue(cached, catalog);
    if (controlDirector && isControlDirectorPrimaryModelRef(cachedValue)) {
      return "";
    }
    return cachedValue;
  }
  if (cached === null) {
    return "";
  }

  const activeRow = resolveActiveSessionRow(state);
  if (
    controlDirector &&
    resolveControlDirectorPrimaryModelValue({
      agentId: resolveAgentIdFromSessionKey(state.sessionKey),
      provider: activeRow?.modelProvider,
      model: activeRow?.model,
    })
  ) {
    return "";
  }
  return resolvePreferredServerChatModelValue(activeRow?.model, activeRow?.modelProvider, catalog);
}

function resolveDefaultModelValue(state: ChatModelSelectStateInput): string {
  const agentId = resolveAgentIdFromSessionKey(state.sessionKey);
  const canonicalControlDirectorDefault = resolveControlDirectorPrimaryModelValue({
    agentId,
    provider: state.sessionsResult?.defaults?.modelProvider,
    model: state.sessionsResult?.defaults?.model,
  });
  if (canonicalControlDirectorDefault) {
    return canonicalControlDirectorDefault;
  }
  return resolvePreferredServerChatModelValue(
    state.sessionsResult?.defaults?.model,
    state.sessionsResult?.defaults?.modelProvider,
    state.chatModelCatalog ?? [],
  );
}

function buildChatModelOptions(
  catalog: ModelCatalogEntry[],
  displayLookup: ReturnType<typeof buildCatalogDisplayLookup>,
  currentOverride: string,
  defaultModel: string,
): ChatModelSelectOption[] {
  const seen = new Set<string>();
  const options: ChatModelSelectOption[] = [];

  const addOption = (value: string, label?: string) => {
    pushUniqueTrimmedSelectOption(options, seen, value, (trimmed) => label ?? trimmed);
  };

  for (const entry of catalog) {
    const option = buildChatModelOptionFromLookup(entry, displayLookup);
    addOption(option.value, option.label);
  }

  if (currentOverride) {
    addOption(
      currentOverride,
      formatControlDirectorPrimaryModelDisplay(currentOverride) ??
        formatCatalogChatModelDisplayFromLookup(currentOverride, displayLookup),
    );
  }
  if (defaultModel) {
    addOption(
      defaultModel,
      formatControlDirectorPrimaryModelDisplay(defaultModel) ??
        formatCatalogChatModelDisplayFromLookup(defaultModel, displayLookup),
    );
  }
  return options;
}

export function resolveChatModelSelectState(
  state: ChatModelSelectStateInput,
): ChatModelSelectState {
  const catalog = state.chatModelCatalog ?? [];
  const displayLookup = buildCatalogDisplayLookup(catalog);
  const currentOverride = resolveChatModelOverrideValue(state);
  const defaultModel = resolveDefaultModelValue(state);
  const defaultDisplay =
    formatControlDirectorPrimaryModelDisplay(defaultModel) ??
    formatCatalogChatModelDisplayFromLookup(defaultModel, displayLookup);

  return {
    currentOverride,
    defaultModel,
    defaultDisplay,
    defaultLabel: defaultModel ? `Default (${defaultDisplay})` : "Default model",
    options: buildChatModelOptions(catalog, displayLookup, currentOverride, defaultModel),
  };
}
