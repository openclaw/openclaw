import type {
  FastMode,
  GatewaySessionRow,
  ModelCatalogEntry,
  ModelCatalogResult,
  SessionsListResult,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { resolveModelRuntimeEntry, type ModelRuntimeEntry } from "../model-runtime-choice.ts";
import {
  buildCatalogDisplayLookup,
  buildChatModelOptionFromLookup,
  buildQualifiedChatModelValue,
  formatCatalogChatModelDisplayFromLookup,
  normalizeChatModelProviderId,
  normalizeChatModelOverrideValue,
  resolvePreferredServerChatModelValue,
} from "./model-ref.ts";

registerModelControlsEnglish();

type ChatModelSelectStateInput = {
  activeSession?: GatewaySessionRow;
  agentDefaultModel?: string;
  chatModelCatalog: ModelCatalogEntry[];
  modelOverrides: Readonly<Record<string, string | null | undefined>>;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
  modelSelectionPolicy?: ModelCatalogResult["modelSelectionPolicy"];
  catalogRetired?: boolean;
  catalogInitialized?: boolean;
};

type ChatModelSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  unavailableReason?: ModelCatalogEntry["unavailableReason"];
};

type ChatModelSelectState = {
  currentOverride: string;
  defaultModel: string;
  defaultLabel: string;
  modelOverrideSource: GatewaySessionRow["modelOverrideSource"];
  options: ChatModelSelectOption[];
};

export type ChatFastModeSelectValue = "" | "on" | "off" | "auto" | "ultrafast";

export type ChatFastModeSelectState = {
  /** Fast output is effectively enabled (explicitly or via auto/inherited default). */
  active: boolean;
  currentOverride: ChatFastModeSelectValue;
  disabled: boolean;
  /** Resolved speed label, separate from the saved preference. */
  label: string;
  /** Value the toggle commits when clicked. */
  nextValue: ChatFastModeSelectValue;
  supported: boolean;
  /** True: offered; false: model-restricted; undefined: capability not confirmed. */
  ultrafastSupported?: boolean;
};

export type ChatFastModeTarget = Pick<
  GatewaySessionRow,
  "effectiveFastMode" | "fastMode" | "model" | "modelProvider" | "agentRuntime"
>;

type ChatFastModeSelectStateInput = {
  activeRunId: string | null;
  catalog: ModelCatalogEntry[];
  connected: boolean;
  currentModelOverride: string;
  fastModeTarget?: ChatFastModeTarget;
  gatewayAvailable: boolean;
  loading: boolean;
  sending: boolean;
  sessionsResult: SessionsListResult | null;
  stream: string | null;
};

// Preserve existing controls only when the selected request's applicability is unknown.
const FAST_MODE_PROVIDER_IDS = new Set(["anthropic", "minimax", "minimax-portal", "openai", "xai"]);

export function isChatFastModeProviderSupported(provider: string | null | undefined): boolean {
  return FAST_MODE_PROVIDER_IDS.has(normalizeChatModelProviderId(provider ?? ""));
}

function resolveModelOverrideSource(state: ChatModelSelectStateInput) {
  // A local selection is newer than the row that still reports the previous
  // provenance, so it owns the answer until the refreshed row lands.
  if (Object.hasOwn(state.modelOverrides, state.sessionKey)) {
    return state.modelOverrides[state.sessionKey] == null ? null : "user";
  }
  return state.activeSession?.modelOverrideSource;
}

export function resolveChatModelOverrideValue(state: ChatModelSelectStateInput): string {
  const catalog = state.chatModelCatalog ?? [];

  const sharedOverrides = state.modelOverrides;
  if (Object.hasOwn(sharedOverrides, state.sessionKey)) {
    return normalizeChatModelOverrideValue(sharedOverrides[state.sessionKey], catalog);
  }

  const active = state.activeSession;
  return resolvePreferredServerChatModelValue(active?.model, active?.modelProvider, catalog);
}

function resolveDefaultModelValue(state: ChatModelSelectStateInput): string {
  if (state.catalogRetired || state.catalogInitialized === false) {
    return "";
  }
  if (state.modelSelectionPolicy?.restricted) {
    return state.modelSelectionPolicy.defaultModel ?? "";
  }
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

function catalogModelAvailabilityKey(entry: ModelCatalogEntry): string {
  return normalizeChatModelAvailabilityKey(buildQualifiedChatModelValue(entry.id, entry.provider));
}

function resolveCatalogChatModelValue(value: string, options: ChatModelSelectOption[]): string {
  const exactValue = value.trim().toLowerCase();
  if (!exactValue) {
    return value;
  }
  const normalizedValue = normalizeChatModelAvailabilityKey(value);
  for (const disabled of [false, true]) {
    const match = options.find(
      (option) =>
        Boolean(option.disabled) === disabled &&
        (option.value.trim().toLowerCase() === exactValue ||
          normalizeChatModelAvailabilityKey(option.value) === normalizedValue),
    );
    if (match) {
      return match.value;
    }
  }
  return value;
}

function buildChatModelOptions(
  catalog: ModelCatalogEntry[],
  displayLookup: ReturnType<typeof buildCatalogDisplayLookup>,
): ChatModelSelectOption[] {
  const seen = new Set<string>();
  const options: ChatModelSelectOption[] = [];

  for (const entry of catalog.toSorted(
    (left, right) =>
      Number(left.available === false) - Number(right.available === false) ||
      Number(left.provider.trim().toLowerCase() !== normalizeChatModelProviderId(left.provider)) -
        Number(
          right.provider.trim().toLowerCase() !== normalizeChatModelProviderId(right.provider),
        ),
  )) {
    if (entry.manualSelectionAllowed === false) {
      continue;
    }
    const option = buildChatModelOptionFromLookup(entry, displayLookup);
    const value = option.value.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) {
      continue;
    }
    seen.add(key);
    options.push({
      ...option,
      ...(entry.available === false
        ? { disabled: true, unavailableReason: entry.unavailableReason }
        : {}),
    });
  }
  return options;
}

export function resolveChatModelUnavailableReason(
  model: string | null | undefined,
  provider: string | null | undefined,
  catalog: ModelCatalogEntry[],
): ModelCatalogEntry["unavailableReason"] {
  const value = resolvePreferredServerChatModelValue(model, provider, catalog);
  const key = normalizeChatModelAvailabilityKey(value);
  const matches = catalog.filter((entry) => catalogModelAvailabilityKey(entry) === key);
  if (
    !matches.length ||
    matches.some((entry) => entry.available !== false || !entry.unavailableReason)
  ) {
    return undefined;
  }
  // Any recovering route can still serve the selection. Do not let an alias's
  // permanent auth failure turn a transient catalog snapshot into a send gate.
  if (matches.some((entry) => entry.unavailableReason === "cooldown")) {
    return "cooldown";
  }
  return matches.some((entry) => entry.unavailableReason === "auth-failed")
    ? "auth-failed"
    : "missing-auth";
}

export function hasChatModelCatalogSelection(
  model: string | null | undefined,
  provider: string | null | undefined,
  catalog: ModelCatalogEntry[],
): boolean {
  const key = normalizeChatModelAvailabilityKey(
    resolvePreferredServerChatModelValue(model, provider, catalog),
  );
  return catalog.some(
    (entry) => entry.manualSelectionAllowed !== false && catalogModelAvailabilityKey(entry) === key,
  );
}

export function chatModelUnavailableMessage(
  reason: ModelRuntimeEntry["unavailableReason"],
): string | undefined {
  if (reason === "missing-auth") {
    return t("modelSetup.missingAuth");
  }
  if (reason === "unsupported-runtime") {
    return t("chat.modelControls.runtimeUnavailable");
  }
  return reason === "auth-failed"
    ? `${t("modelSetup.failure.auth")}. ${t("modelSetup.failureGuidance.auth")}`
    : undefined;
}

export function resolveChatModelSelectState(
  state: ChatModelSelectStateInput,
): ChatModelSelectState {
  const catalog = state.chatModelCatalog ?? [];
  const availableKeys = new Set(
    catalog.filter((entry) => entry.available !== false).map(catalogModelAvailabilityKey),
  );
  // Catalog members already have a qualified identity. Prepare one retained inventory
  // so unavailable aliases cannot disambiguate labels for their selectable sibling.
  const pickerCatalog = catalog.filter(
    (entry) => entry.available !== false || !availableKeys.has(catalogModelAvailabilityKey(entry)),
  );
  const displayLookup = buildCatalogDisplayLookup(pickerCatalog);
  const options = buildChatModelOptions(pickerCatalog, displayLookup);
  const currentOverride = resolveCatalogChatModelValue(
    resolveChatModelOverrideValue(state),
    options,
  );
  const defaultModel = resolveCatalogChatModelValue(resolveDefaultModelValue(state), options);
  const defaultLabel = formatCatalogChatModelDisplayFromLookup(defaultModel, displayLookup);

  return {
    currentOverride,
    defaultModel,
    defaultLabel: defaultModel ? `Default (${defaultLabel})` : "Default model",
    modelOverrideSource: resolveModelOverrideSource(state),
    options,
  };
}

export function normalizeChatFastModeInput(raw: string): FastMode | undefined {
  if (raw === "auto" || raw === "ultrafast") {
    return raw;
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
  const mode = session?.effectiveFastMode ?? session?.fastMode;
  const value =
    mode === "auto"
      ? t("chat.commandResults.fast.autoValue", {
          seconds: String(session?.fastAutoOnSeconds ?? 60),
        })
      : mode === "ultrafast"
        ? t("chat.modelControls.ultrafast")
        : t(mode === true ? "chat.commandResults.fast.on" : "chat.commandResults.fast.off");
  const source = session?.effectiveFastModeSource;
  const sourceSuffix =
    source === "session"
      ? t("chat.commandResults.fast.sourceSession")
      : source === "agent"
        ? t("chat.commandResults.fast.sourceAgent")
        : source === "config"
          ? t("chat.commandResults.fast.sourceModel")
          : source === "default"
            ? t("chat.commandResults.fast.sourceDefault")
            : "";
  return `${t("chat.commandResults.fast.current", { value })}${sourceSuffix}.`;
}

function resolveFastModeProvider(
  value: string,
  catalog: ModelCatalogEntry[],
  sessionProvider: string | null,
  defaultProvider: string | null,
): string | null {
  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue) {
    return sessionProvider ?? defaultProvider;
  }
  const idProviders = new Set<string>();
  const qualifiedProviders = new Set<string>();
  let hasCatalogMatch = false;
  for (const entry of catalog) {
    const matchesId = entry.id.trim().toLowerCase() === normalizedValue;
    const matchesQualified =
      buildQualifiedChatModelValue(entry.id, entry.provider).trim().toLowerCase() ===
      normalizedValue;
    if (!matchesId && !matchesQualified) {
      continue;
    }
    hasCatalogMatch = true;
    const provider = normalizeChatModelProviderId(entry.provider);
    if (provider) {
      if (matchesId) {
        idProviders.add(provider);
      }
      if (matchesQualified) {
        qualifiedProviders.add(provider);
      }
    }
  }
  if (qualifiedProviders.size === 1) {
    return [...qualifiedProviders][0] ?? null;
  }
  if (
    sessionProvider &&
    idProviders.has(sessionProvider) &&
    !qualifiedProviders.has(sessionProvider)
  ) {
    return sessionProvider;
  }
  if (idProviders.size === 1) {
    return [...idProviders][0] ?? null;
  }
  // An ambiguous catalog match must not be replaced by a stale session/default provider.
  return hasCatalogMatch ? null : (sessionProvider ?? defaultProvider);
}

function isChatStandardOnlySpeed(
  entry: Pick<ModelRuntimeEntry, "supportsFastMode" | "serviceTiers"> | undefined,
  canRecoverRejectedTier: boolean,
): boolean {
  return (
    entry?.serviceTiers !== undefined &&
    !entry.serviceTiers.some((tier) => tier === "priority" || tier === "ultrafast") &&
    (canRecoverRejectedTier ||
      (entry.supportsFastMode === false &&
        entry.serviceTiers.length === 1 &&
        entry.serviceTiers[0] === "default"))
  );
}

export function resolveChatFastModeSelectState(
  input: ChatFastModeSelectStateInput,
): ChatFastModeSelectState {
  const activeRow = input.fastModeTarget;
  const activeProvider = normalizeChatModelProviderId(activeRow?.modelProvider ?? "") || null;
  const defaultProvider =
    normalizeChatModelProviderId(input.sessionsResult?.defaults?.modelProvider ?? "") || null;
  const effectiveProvider = resolveFastModeProvider(
    input.currentModelOverride,
    input.catalog,
    activeProvider,
    defaultProvider,
  );
  const configuredOverride =
    activeRow?.fastMode === "auto" || activeRow?.fastMode === "ultrafast"
      ? activeRow.fastMode
      : activeRow?.fastMode === true
        ? "on"
        : activeRow?.fastMode === false
          ? "off"
          : "";
  const isOpenAI = effectiveProvider === "openai";
  const savedMode = activeRow?.effectiveFastMode ?? activeRow?.fastMode;
  const selectedValue = normalizeChatModelAvailabilityKey(
    normalizeChatModelOverrideValue(
      input.currentModelOverride ||
        buildQualifiedChatModelValue(
          activeRow?.model ?? input.sessionsResult?.defaults?.model ?? "",
          effectiveProvider,
        ),
      input.catalog,
    ),
  );
  const selectedEntries = input.catalog
    .filter((entry) => catalogModelAvailabilityKey(entry) === selectedValue)
    .map((entry) => ({
      entry,
      runtime: resolveModelRuntimeEntry(entry, activeRow?.agentRuntime?.id),
    }));
  const applicability = new Set(
    selectedEntries.map(({ entry, runtime }) => (runtime ?? entry).supportsFastMode),
  );
  const selectedSupport = applicability.size === 1 ? [...applicability][0] : undefined;
  const requestSupported = selectedSupport ?? isChatFastModeProviderSupported(effectiveProvider);
  const ultrafastOffered =
    requestSupported &&
    selectedEntries.length > 0 &&
    selectedEntries.every(
      ({ runtime }) => runtime?.available === true && runtime.serviceTiers?.includes("ultrafast"),
    );
  // The transport owns recovery support; provider and runtime names do not identify the endpoint.
  const canRecoverRejectedTier =
    selectedEntries.length > 0 &&
    selectedEntries.every(({ runtime }) => runtime?.supportsServiceTierRecovery === true);
  const standardOnly =
    selectedEntries.length > 0 &&
    selectedEntries.every(({ runtime }) =>
      isChatStandardOnlySpeed(runtime, canRecoverRejectedTier),
    );
  const ultrafastUnavailable =
    selectedEntries.length > 0 &&
    selectedEntries.every(
      ({ runtime }) =>
        runtime?.serviceTiers !== undefined && !runtime.serviceTiers.includes("ultrafast"),
    );
  const effectiveMode = standardOnly
    ? false
    : savedMode === "ultrafast" &&
        canRecoverRejectedTier &&
        ultrafastUnavailable &&
        requestSupported
      ? true
      : savedMode;
  // Capability changes the effective choice without rewriting the saved session preference.
  const currentOverride =
    isOpenAI || standardOnly
      ? effectiveMode === true
        ? "on"
        : effectiveMode === "auto" || effectiveMode === "ultrafast"
          ? effectiveMode
          : "off"
      : configuredOverride;
  const supported = standardOnly || requestSupported || Boolean(configuredOverride);
  // A saved Ultrafast setting remains Ultrafast even when access is unavailable.
  const active =
    effectiveMode === true || effectiveMode === "auto" || effectiveMode === "ultrafast";
  const label =
    effectiveMode === "auto"
      ? "Auto"
      : effectiveMode === "ultrafast"
        ? "Ultrafast"
        : active
          ? "Fast"
          : isOpenAI || currentOverride === "off"
            ? "Standard"
            : "Default";
  // A legacy override on a provider without a wire mapping stays visible so it
  // can be cleared, but the toggle must not write a new no-op fast override.
  // For mapped providers an active toggle always writes an explicit off: the
  // inherited baseline is unknowable while an override exists, and clearing
  // could land on a fast default, turning the click into a visible no-op.
  // /fast default remains the way back to the inherited setting.
  const nextValue: ChatFastModeSelectValue = standardOnly
    ? "off"
    : !requestSupported
      ? ""
      : active
        ? "off"
        : "on";
  return {
    active,
    currentOverride,
    disabled:
      standardOnly ||
      !supported ||
      !input.connected ||
      input.loading ||
      input.sending ||
      Boolean(input.activeRunId) ||
      input.stream !== null ||
      !input.gatewayAvailable,
    label,
    nextValue,
    supported,
    ultrafastSupported: ultrafastUnavailable ? false : ultrafastOffered || undefined,
  };
}
