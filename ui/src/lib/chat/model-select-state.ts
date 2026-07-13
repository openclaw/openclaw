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
  createChatModelOverride,
  formatCatalogChatModelDisplayFromLookup,
  normalizeChatModelOverrideValue,
  resolvePreferredServerChatModelValue,
} from "./model-ref.ts";

type ChatModelSelectStateInput = {
  chatModelCatalog: ModelCatalogEntry[];
  modelOverrides: Readonly<Record<string, string | null | undefined>>;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
};

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
      formatCatalogChatModelDisplayFromLookup(currentOverride, displayLookup),
    );
  }
  if (defaultModel) {
    addOption(defaultModel, formatCatalogChatModelDisplayFromLookup(defaultModel, displayLookup));
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
  const defaultDisplay = formatCatalogChatModelDisplayFromLookup(defaultModel, displayLookup);

  return {
    currentOverride,
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

function resolveProviderFromModelValue(value: string, catalog: ModelCatalogEntry[]): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const separator = trimmed.indexOf("/");
  if (separator > 0) {
    return trimmed.slice(0, separator).toLowerCase();
  }
  return (
    catalog
      .find((entry) => entry.id.trim().toLowerCase() === trimmed.toLowerCase())
      ?.provider.trim()
      .toLowerCase() || null
  );
}

export function resolveChatFastModeSelectState(
  input: ChatFastModeSelectStateInput,
): ChatFastModeSelectState {
  const activeRow = input.sessionsResult?.sessions?.find((row) => row.key === input.sessionKey);
  const defaultProvider = input.sessionsResult?.defaults?.modelProvider;
  const effectiveProvider =
    resolveProviderFromModelValue(input.currentModelOverride, input.catalog) ??
    activeRow?.modelProvider?.trim().toLowerCase() ??
    defaultProvider?.trim().toLowerCase() ??
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
