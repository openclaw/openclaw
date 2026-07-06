// Chat model select state derivation.
import { formatFastModeCurrentStatus } from "../../../../src/shared/fast-mode.js";
import type {
  FastMode,
  GatewaySessionRow,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import { pushUniqueTrimmedSelectOption } from "../select-options.ts";
import {
  buildCatalogDisplayLookup,
  buildChatModelOptionFromLookup,
  buildQualifiedChatModelValue,
  createChatModelOverride,
  formatCatalogChatModelDisplayFromLookup,
  normalizeChatModelProviderId,
  normalizeChatModelOverrideValue,
  resolvePreferredServerChatModelValue,
} from "./model-ref.ts";

type ChatModelSelectStateInput = {
  agentDefaultModel?: string;
  chatModelCatalog: ModelCatalogEntry[];
  modelOverrides: Readonly<Record<string, string | null | undefined>>;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
};

export type ChatModelSelectOption = {
  value: string;
  label: string;
};

type ChatModelSelectState = {
  currentOverride: string;
  defaultSelectable: boolean;
  defaultModel: string;
  defaultDisplay: string;
  defaultLabel: string;
  options: ChatModelSelectOption[];
};

export type ChatFastModeSelectValue = "" | "on" | "off" | "auto";

export type ChatFastModeSelectState = {
  currentOverride: ChatFastModeSelectValue;
  disabled: boolean;
  options: ChatModelSelectOption[];
  supported: boolean;
};

type ChatFastModeSelectStateInput = {
  activeRunId: string | null;
  catalog: ModelCatalogEntry[];
  connected: boolean;
  currentModelOverride: string;
  gatewayAvailable: boolean;
  loading: boolean;
  sending: boolean;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
  stream: string | null;
};

const FAST_MODE_PROVIDER_IDS = new Set([
  "anthropic",
  "minimax",
  "minimax-portal",
  "openai",
  "openrouter",
  "xai",
]);

function resolveActiveSessionRow(state: ChatModelSelectStateInput) {
  return state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
}

export function resolveChatModelOverrideValue(state: ChatModelSelectStateInput): string {
  const catalog = state.chatModelCatalog ?? [];

  const sharedOverrides = state.modelOverrides;
  if (Object.hasOwn(sharedOverrides, state.sessionKey)) {
    const shared = sharedOverrides[state.sessionKey];
    return shared == null
      ? ""
      : normalizeChatModelOverrideValue(createChatModelOverride(shared), catalog);
  }

  const activeRow = resolveActiveSessionRow(state);
  return resolvePreferredServerChatModelValue(activeRow?.model, activeRow?.modelProvider, catalog);
}

function resolveDefaultModelValue(state: ChatModelSelectStateInput): string {
  const agentDefault = resolvePreferredServerChatModelValue(
    state.agentDefaultModel,
    undefined,
    state.chatModelCatalog ?? [],
  );
  if (agentDefault) {
    return agentDefault;
  }
  return resolvePreferredServerChatModelValue(
    state.sessionsResult?.defaults?.model,
    state.sessionsResult?.defaults?.modelProvider,
    state.chatModelCatalog ?? [],
  );
}

function normalizeChatModelAvailabilityKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  const separator = normalized.indexOf("/");
  if (separator <= 0) {
    return normalized;
  }
  return `${normalizeChatModelProviderId(normalized.slice(0, separator))}/${normalized.slice(
    separator + 1,
  )}`;
}

function buildUnavailableChatModelValues(
  catalog: ModelCatalogEntry[],
  displayLookup: ReturnType<typeof buildCatalogDisplayLookup>,
): Set<string> {
  const availableValues = new Set(
    catalog
      .filter((entry) => entry.available !== false)
      .map((entry) =>
        normalizeChatModelAvailabilityKey(
          buildChatModelOptionFromLookup(entry, displayLookup).value,
        ),
      ),
  );
  return new Set(
    catalog
      .filter((entry) => entry.available === false)
      .map((entry) =>
        normalizeChatModelAvailabilityKey(
          buildChatModelOptionFromLookup(entry, displayLookup).value,
        ),
      )
      .filter((value) => !availableValues.has(value)),
  );
}

function resolveAvailableChatModelValue(
  value: string,
  catalog: ModelCatalogEntry[],
  displayLookup: ReturnType<typeof buildCatalogDisplayLookup>,
): string {
  const exactValue = value.trim().toLowerCase();
  if (!exactValue) {
    return value;
  }
  for (const entry of catalog) {
    if (entry.available === false) {
      continue;
    }
    const option = buildChatModelOptionFromLookup(entry, displayLookup);
    if (option.value.trim().toLowerCase() === exactValue) {
      return option.value;
    }
  }
  const normalizedValue = normalizeChatModelAvailabilityKey(value);
  for (const entry of catalog) {
    if (entry.available === false) {
      continue;
    }
    const option = buildChatModelOptionFromLookup(entry, displayLookup);
    if (normalizeChatModelAvailabilityKey(option.value) === normalizedValue) {
      return option.value;
    }
  }
  return value;
}

function buildChatModelOptions(
  catalog: ModelCatalogEntry[],
  displayLookup: ReturnType<typeof buildCatalogDisplayLookup>,
  currentOverride: string,
  defaultModel: string,
): ChatModelSelectOption[] {
  const seen = new Set<string>();
  const options: ChatModelSelectOption[] = [];
  const unavailableValues = buildUnavailableChatModelValues(catalog, displayLookup);

  const addOption = (value: string, label?: string) => {
    pushUniqueTrimmedSelectOption(options, seen, value, (trimmed) => label ?? trimmed);
  };
  const addAvailableOption = (value: string, label?: string) => {
    if (!unavailableValues.has(normalizeChatModelAvailabilityKey(value))) {
      addOption(value, label);
    }
  };

  for (const entry of catalog) {
    if (entry.available === false) {
      continue;
    }
    const option = buildChatModelOptionFromLookup(entry, displayLookup);
    addOption(option.value, option.label);
  }

  if (currentOverride) {
    addAvailableOption(
      currentOverride,
      formatCatalogChatModelDisplayFromLookup(currentOverride, displayLookup),
    );
  }
  if (defaultModel) {
    addAvailableOption(
      defaultModel,
      formatCatalogChatModelDisplayFromLookup(defaultModel, displayLookup),
    );
  }
  return options;
}

export function resolveChatModelSelectState(
  state: ChatModelSelectStateInput,
): ChatModelSelectState {
  const catalog = state.chatModelCatalog ?? [];
  const displayLookup = buildCatalogDisplayLookup(
    catalog.filter((entry) => entry.available !== false),
  );
  const currentOverride = resolveAvailableChatModelValue(
    resolveChatModelOverrideValue(state),
    catalog,
    displayLookup,
  );
  const defaultModel = resolveAvailableChatModelValue(
    resolveDefaultModelValue(state),
    catalog,
    displayLookup,
  );
  const defaultDisplay = formatCatalogChatModelDisplayFromLookup(defaultModel, displayLookup);
  const unavailableValues = buildUnavailableChatModelValues(catalog, displayLookup);
  const defaultSelectable =
    !defaultModel || !unavailableValues.has(normalizeChatModelAvailabilityKey(defaultModel));

  return {
    currentOverride,
    defaultSelectable,
    defaultModel,
    defaultDisplay,
    defaultLabel: defaultModel ? `Default (${defaultDisplay})` : "Default model",
    options: buildChatModelOptions(catalog, displayLookup, currentOverride, defaultModel),
  };
}

export function normalizeChatFastModeInput(raw: string): FastMode | undefined {
  if (raw === "auto") {
    return "auto";
  }
  if (raw === "on") {
    return true;
  }
  if (raw === "off") {
    return false;
  }
  return undefined;
}

export function resolveChatFastModeStatus(session: GatewaySessionRow | undefined): string {
  return formatFastModeCurrentStatus({
    mode: session?.effectiveFastMode ?? session?.fastMode,
    source: session?.effectiveFastModeSource,
    fastAutoOnSeconds: session?.fastAutoOnSeconds,
  });
}

function resolveProviderFromModelValue(
  value: string,
  catalog: ModelCatalogEntry[],
  providerHint: string | null,
): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalizedValue = trimmed.toLowerCase();
  const idProviders = new Set(
    catalog
      .filter((entry) => entry.id.trim().toLowerCase() === normalizedValue)
      .map((entry) => normalizeChatModelProviderId(entry.provider))
      .filter(Boolean),
  );
  const qualifiedProviders = new Set(
    catalog
      .filter(
        (entry) =>
          buildQualifiedChatModelValue(entry.id, entry.provider).trim().toLowerCase() ===
          normalizedValue,
      )
      .map((entry) => normalizeChatModelProviderId(entry.provider))
      .filter(Boolean),
  );
  if (qualifiedProviders.size === 1) {
    return [...qualifiedProviders][0] ?? null;
  }
  if (providerHint && idProviders.has(providerHint) && !qualifiedProviders.has(providerHint)) {
    return providerHint;
  }
  return idProviders.size === 1 ? ([...idProviders][0] ?? null) : null;
}

function hasCatalogProviderMetadata(value: string, catalog: ModelCatalogEntry[]): boolean {
  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue) {
    return false;
  }
  return catalog.some((entry) => {
    const normalizedId = entry.id.trim().toLowerCase();
    const qualifiedValue = buildQualifiedChatModelValue(entry.id, entry.provider)
      .trim()
      .toLowerCase();
    return normalizedId === normalizedValue || qualifiedValue === normalizedValue;
  });
}

export function resolveChatFastModeSelectState(
  input: ChatFastModeSelectStateInput,
): ChatFastModeSelectState {
  const activeRow = input.sessionsResult?.sessions?.find((row) => row.key === input.sessionKey);
  const activeProvider = normalizeChatModelProviderId(activeRow?.modelProvider ?? "") || null;
  const defaultProvider =
    normalizeChatModelProviderId(input.sessionsResult?.defaults?.modelProvider ?? "") || null;
  const catalogHasProviderMetadata = hasCatalogProviderMetadata(
    input.currentModelOverride,
    input.catalog,
  );
  const fallbackProvider =
    !input.currentModelOverride || !catalogHasProviderMetadata
      ? (activeProvider ?? defaultProvider)
      : null;
  const effectiveProvider =
    resolveProviderFromModelValue(input.currentModelOverride, input.catalog, activeProvider) ??
    fallbackProvider ??
    null;
  const configuredOverride =
    activeRow?.fastMode === "auto"
      ? "auto"
      : activeRow?.fastMode === true
        ? "on"
        : activeRow?.fastMode === false
          ? "off"
          : "";
  const isOpenAI = effectiveProvider === "openai";
  const effectiveOpenAIMode = activeRow?.effectiveFastMode ?? activeRow?.fastMode;
  // OpenAI exposes one optional priority tier. Keep legacy auto unselected so
  // either binary choice replaces it instead of implying the wrong tier.
  const currentOverride = isOpenAI
    ? effectiveOpenAIMode === true
      ? "on"
      : effectiveOpenAIMode === "auto"
        ? "auto"
        : "off"
    : configuredOverride;
  const supported = Boolean(
    (effectiveProvider && FAST_MODE_PROVIDER_IDS.has(effectiveProvider)) || configuredOverride,
  );
  return {
    currentOverride,
    disabled:
      !supported ||
      !input.connected ||
      input.loading ||
      input.sending ||
      Boolean(input.activeRunId) ||
      input.stream !== null ||
      !input.gatewayAvailable,
    options: isOpenAI
      ? [
          { value: "off", label: "Standard" },
          { value: "on", label: "Fast" },
        ]
      : [
          { value: "", label: "Default" },
          { value: "on", label: "Fast" },
          { value: "off", label: "Standard" },
          { value: "auto", label: "Auto" },
        ],
    supported,
  };
}
