// Chat-owned model, reasoning, speed, quota, and settings controls.
import { html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type {
  AgentsListResult,
  GatewayThinkingLevelOption,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../../api/types.ts";
import { pathForRoute, type RouteId } from "../../../app-routes.ts";
import {
  normalizeChatAutoScrollMode,
  type ChatAutoScrollMode,
  type UiSettings,
} from "../../../app/settings.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { resolveChatModelSelectState } from "../../../lib/chat/model-select-state.ts";
import {
  formatInheritedThinkingLabel,
  formatThinkingOverrideLabel,
  normalizeThinkingOptionValue,
  type ThinkingCatalogEntry,
  listThinkingLevelLabels,
  normalizeThinkLevel,
  resolveThinkingDefaultForModel,
} from "../../../lib/chat/thinking.ts";
import { isMonitoredAuthProvider } from "../../../lib/model-auth-helpers.ts";
import {
  collectQuotaWindowsFromAuthStatus,
  formatQuotaReset,
} from "../../../lib/provider-quota-summary.ts";
import { pushUniqueTrimmedSelectOption } from "../../../lib/select-options.ts";
import { isCronSessionKey } from "../../../lib/session-display.ts";
import { sessionModelMatchesDefaults } from "../../../lib/session-model-defaults.ts";
import {
  isSessionKeyTiedToAgent,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../../lib/sessions/session-key.ts";
import { normalizeLowercaseStringOrEmpty } from "../../../lib/string-coerce.ts";

type ChatInlineSelectOption = {
  value: string;
  label: string;
};

type ChatThinkingSelectOption = {
  value: string;
  label: string;
};

type ChatThinkingSelectState = {
  currentOverride: string;
  defaultLabel: string;
  defaultValue: string;
  options: ChatThinkingSelectOption[];
};

type ChatFastModeSelectState = {
  currentOverride: "" | "on" | "off" | "auto";
  disabled: boolean;
  options: ChatInlineSelectOption[];
  supported: boolean;
};

export type ChatModelControlsState = {
  basePath?: string;
  chatLoading: boolean;
  chatModelCatalog: ModelCatalogEntry[];
  chatModelsLoading?: boolean;
  chatModelSwitchPromises?: Record<string, Promise<boolean>>;
  chatRunId: string | null;
  chatSending: boolean;
  chatStream: string | null;
  chatThinkingLevel: string | null;
  client: unknown;
  connected: boolean;
  agentsList: AgentsListResult | null;
  modelAuthStatusResult?: ModelAuthStatusResult | null;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
};

export type ChatControlsState = ChatModelControlsState & {
  chatManualRefreshInFlight: boolean;
  chatMobileControlsOpen: boolean;
  onboarding: boolean;
  requestUpdate?: () => void;
  settings: UiSettings;
  sessionsHideCron: boolean;
  applySettings: (next: UiSettings) => void;
  setChatMobileControlsOpen: (
    open: boolean,
    options?: { trigger?: HTMLElement | null; restoreFocus?: boolean },
  ) => void;
};

export type ChatModelControlsOptions = {
  modelOverrides?: Readonly<Record<string, string | null>>;
  onFastModeSelect?: (value: "" | "on" | "off" | "auto") => Promise<unknown> | unknown;
  onModelSelect?: (value: string) => Promise<unknown> | unknown;
  onThinkingSelect?: (value: string) => Promise<unknown> | unknown;
};

export type ChatControlsOptions = ChatModelControlsOptions & {
  onNavigate?: (routeId: RouteId) => void;
  onRefresh: () => Promise<void> | void;
};

const FAST_MODE_PROVIDER_IDS = new Set([
  "anthropic",
  "minimax",
  "minimax-portal",
  "openai",
  "openrouter",
  "xai",
]);

function chatAutoScrollLabel(mode: ChatAutoScrollMode) {
  switch (mode) {
    case "always":
      return t("chat.autoScrollAlways");
    case "off":
      return t("chat.autoScrollOff");
    case "near-bottom":
      return t("chat.autoScrollNearBottom");
  }
  return t("chat.autoScrollNearBottom");
}

function nextChatAutoScrollMode(mode: ChatAutoScrollMode): ChatAutoScrollMode {
  switch (mode) {
    case "near-bottom":
      return "always";
    case "always":
      return "off";
    case "off":
      return "near-bottom";
  }
  return "near-bottom";
}

function renderChatAutoScrollToggle(state: Pick<ChatControlsState, "applySettings" | "settings">) {
  const mode = normalizeChatAutoScrollMode(state.settings.chatAutoScroll);
  const label = `${t("chat.autoScrollMode")}: ${chatAutoScrollLabel(mode)}`;
  const active = mode !== "off";
  return html`
    <openclaw-tooltip .content=${label}>
      <button
        class="btn btn--sm btn--icon chat-settings-action ${active ? "active" : ""}"
        data-chat-auto-scroll-toggle="true"
        data-chat-auto-scroll-mode=${mode}
        aria-label=${label}
        aria-pressed=${active}
        @click=${() => {
          state.applySettings({
            ...state.settings,
            chatAutoScroll: nextChatAutoScrollMode(mode),
          });
        }}
      >
        ${icons.scrollText}
        <span class="chat-settings-action__text">${t("chat.autoScrollMode")}</span>
      </button>
    </openclaw-tooltip>
  `;
}

function renderCronFilterIcon(hiddenCount: number) {
  return html`
    <span style="position: relative; display: inline-flex; align-items: center;">
      ${icons.clock}
      ${hiddenCount > 0
        ? html`<span
            style="
              position: absolute;
              top: -5px;
              right: -6px;
              background: var(--color-accent, #6366f1);
              color: #fff;
              border-radius: var(--radius-full);
              font-size: 9px;
              line-height: 1;
              padding: 1px 3px;
              pointer-events: none;
            "
            >${hiddenCount}</span
          >`
        : ""}
    </span>
  `;
}

function countHiddenCronSessions(state: ChatControlsState): number {
  const sessions = state.sessionsResult;
  if (!sessions?.sessions) {
    return 0;
  }
  const activeAgentId = normalizeAgentId(
    parseAgentSessionKey(state.sessionKey)?.agentId ?? state.agentsList?.defaultId ?? "main",
  );
  const defaultAgentId = normalizeAgentId(state.agentsList?.defaultId ?? "main");

  return sessions.sessions.filter(
    (row) =>
      isCronSessionKey(row.key) &&
      row.key !== state.sessionKey &&
      isSessionKeyTiedToAgent(row.key, activeAgentId, defaultAgentId),
  ).length;
}

export function renderChatControls(state: ChatControlsState, options: ChatControlsOptions) {
  const hideCron = state.sessionsHideCron ?? true;
  const hiddenCronCount = hideCron ? countHiddenCronSessions(state) : 0;
  const disableThinkingToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const persistCommentary = state.settings.chatPersistCommentary === true;
  const thinkingLabel = disableThinkingToggle
    ? t("chat.onboardingDisabled")
    : t("chat.thinkingToggle");
  const toolCallsLabel = disableThinkingToggle
    ? t("chat.onboardingDisabled")
    : t("chat.toolCallsToggle");
  const commentaryLabel = disableThinkingToggle
    ? t("chat.onboardingDisabled")
    : t("chat.commentaryToggle");
  const refreshDisabled =
    !state.connected ||
    state.chatManualRefreshInFlight ||
    state.chatLoading ||
    state.chatSending ||
    state.chatStream !== null ||
    Boolean(state.chatRunId);
  const cronLabel = hideCron
    ? hiddenCronCount > 0
      ? t("chat.showCronSessionsHidden", { count: String(hiddenCronCount) })
      : t("chat.showCronSessions")
    : t("chat.hideCronSessions");
  const settingsOpen = state.chatMobileControlsOpen;
  const settingsLabel = t("chat.settings");
  const settingsTitle = t("chat.settings");

  return html`
    <div
      class="chat-composer-model-control"
      @click=${() => {
        if (state.chatMobileControlsOpen) {
          state.setChatMobileControlsOpen(false);
        }
      }}
    >
      ${renderChatModelSelect(state, options)}
    </div>
    ${renderChatQuotaPill(state, options.onNavigate)}
    <div class="chat-settings-popover-wrapper">
      <openclaw-tooltip .content=${settingsTitle}>
        <button
          class="chat-settings-chip ${settingsOpen ? "chat-settings-chip--open" : ""}"
          type="button"
          aria-label=${settingsTitle}
          aria-expanded=${settingsOpen}
          aria-controls="chat-composer-settings-popover"
          @click=${(event: Event) => {
            event.stopPropagation();
            (event.currentTarget as HTMLElement)
              .closest(".agent-chat__composer-controls")
              ?.querySelectorAll("details.chat-controls__inline-select[open]")
              .forEach((details) => details.removeAttribute("open"));
            state.setChatMobileControlsOpen(!settingsOpen, {
              trigger: event.currentTarget as HTMLElement,
            });
          }}
        >
          <span class="chat-settings-chip__icon">${icons.settings}</span>
          <span class="chat-settings-chip__text">${settingsLabel}</span>
          <span class="chat-settings-chip__chevron">${icons.chevronDown}</span>
        </button>
      </openclaw-tooltip>
      <div
        id="chat-composer-settings-popover"
        class="chat-settings-popover ${settingsOpen ? "chat-settings-popover--open" : ""}"
        role="dialog"
        aria-label=${settingsTitle}
      >
        <div class="chat-settings-popover__section">
          <span class="chat-settings-popover__label">${settingsLabel}</span>
          <div class="chat-settings-popover__toggles">
            <openclaw-tooltip .content=${t("common.refresh")}>
              <button
                class="btn btn--sm btn--icon chat-settings-action"
                ?disabled=${refreshDisabled}
                @click=${() => {
                  if (!refreshDisabled) {
                    void options.onRefresh();
                  }
                }}
                aria-label=${t("common.refresh")}
              >
                ${icons.refresh}
                <span class="chat-settings-action__text">${t("common.refresh")}</span>
              </button>
            </openclaw-tooltip>
            ${renderChatAutoScrollToggle(state)}
            <openclaw-tooltip .content=${thinkingLabel}>
              <button
                class="btn btn--sm btn--icon chat-settings-action ${showThinking ? "active" : ""}"
                ?disabled=${disableThinkingToggle}
                @click=${() => {
                  if (disableThinkingToggle) {
                    return;
                  }
                  state.applySettings({
                    ...state.settings,
                    chatShowThinking: !state.settings.chatShowThinking,
                  });
                }}
                aria-pressed=${showThinking}
                aria-label=${thinkingLabel}
              >
                ${icons.brain}
                <span class="chat-settings-action__text">${t("cron.form.thinking")}</span>
              </button>
            </openclaw-tooltip>
            <openclaw-tooltip .content=${toolCallsLabel}>
              <button
                class="btn btn--sm btn--icon chat-settings-action ${showToolCalls ? "active" : ""}"
                ?disabled=${disableThinkingToggle}
                @click=${() => {
                  if (disableThinkingToggle) {
                    return;
                  }
                  state.applySettings({
                    ...state.settings,
                    chatShowToolCalls: !state.settings.chatShowToolCalls,
                  });
                }}
                aria-pressed=${showToolCalls}
                aria-label=${toolCallsLabel}
              >
                ${icons.wrench}
                <span class="chat-settings-action__text">${t("agents.tabs.tools")}</span>
              </button>
            </openclaw-tooltip>
            <openclaw-tooltip .content=${commentaryLabel}>
              <button
                class="btn btn--sm btn--icon chat-settings-action ${persistCommentary
                  ? "active"
                  : ""}"
                ?disabled=${disableThinkingToggle}
                @click=${() => {
                  if (disableThinkingToggle) {
                    return;
                  }
                  state.applySettings({
                    ...state.settings,
                    chatPersistCommentary: !persistCommentary,
                  });
                }}
                aria-pressed=${persistCommentary}
                aria-label=${commentaryLabel}
              >
                ${persistCommentary ? icons.pin : icons.pinOff}
                <span class="chat-settings-action__text">${t("chat.commentaryLabel")}</span>
              </button>
            </openclaw-tooltip>
            <openclaw-tooltip .content=${cronLabel}>
              <button
                class="btn btn--sm btn--icon chat-settings-action ${hideCron ? "active" : ""}"
                @click=${() => {
                  state.sessionsHideCron = !hideCron;
                  state.requestUpdate?.();
                }}
                aria-pressed=${hideCron}
                aria-label=${cronLabel}
              >
                ${renderCronFilterIcon(hiddenCronCount)}
                <span class="chat-settings-action__text">${t("cron.jobList.history")}</span>
              </button>
            </openclaw-tooltip>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderChatQuotaPill(
  state: ChatModelControlsState,
  onNavigate?: (routeId: RouteId) => void,
) {
  const windows = collectQuotaWindowsFromAuthStatus(
    state.modelAuthStatusResult ?? null,
    isMonitoredAuthProvider,
  );
  const primary = windows[0];
  if (!primary) {
    return "";
  }
  const secondary = windows.find(
    (entry) => entry.displayName !== primary.displayName || entry.label !== primary.label,
  );
  const reset = formatQuotaReset(primary.resetAt);
  const detail = [primary.displayName, primary.label, reset ? `resets ${reset}` : null]
    .filter(Boolean)
    .join(" · ");
  const secondaryDetail = secondary
    ? `${secondary.displayName}${secondary.label ? ` ${secondary.label}` : ""} ${secondary.remaining}% left`
    : null;
  const title = [detail, secondaryDetail].filter(Boolean).join(" · ");
  const severity = primary.remaining <= 10 ? "danger" : primary.remaining <= 25 ? "warn" : "ok";

  return html`
    <a
      class="chat-controls__quota chat-controls__quota--${severity}"
      href=${pathForRoute("usage", state.basePath ?? "")}
      title=${title}
      aria-label=${`Provider usage: ${title}`}
      data-chat-provider-usage="true"
      @click=${(event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        onNavigate?.("usage");
      }}
    >
      <span class="chat-controls__quota-label">${t("tabs.usage")}</span>
      <span class="chat-controls__quota-value">${primary.remaining}%</span>
    </a>
  `;
}

export function renderChatModelSelect(
  state: ChatModelControlsState,
  callbacks: ChatModelControlsOptions = {},
) {
  const {
    currentOverride,
    defaultLabel,
    options: selectOptions,
  } = resolveChatModelSelectState({
    chatModelCatalog: state.chatModelCatalog,
    modelOverrides: callbacks.modelOverrides ?? {},
    sessionKey: state.sessionKey,
    sessionsResult: state.sessionsResult,
  });
  const thinking = resolveChatThinkingSelectState(state);
  const fastMode = resolveChatFastModeSelectState(state, currentOverride);
  const busy =
    state.chatLoading || state.chatSending || Boolean(state.chatRunId) || state.chatStream !== null;
  const disabled =
    !state.connected ||
    busy ||
    Boolean(state.chatModelSwitchPromises?.[state.sessionKey]) ||
    (state.chatModelsLoading && selectOptions.length === 0) ||
    !state.client;
  const thinkingDisabled =
    !state.connected ||
    busy ||
    !state.client ||
    (thinking.options.length === 0 && thinking.currentOverride === "");
  const selectedLabel =
    currentOverride === ""
      ? defaultLabel
      : (selectOptions.find((entry) => entry.value === currentOverride)?.label ?? currentOverride);
  const selectedThinkingLabel =
    thinking.currentOverride === ""
      ? thinking.defaultLabel
      : (thinking.options.find((entry) => entry.value === thinking.currentOverride)?.label ??
        thinking.currentOverride);
  const modelOptions = [{ value: "", label: defaultLabel }, ...selectOptions];

  return renderChatModelReasoningSelect({
    disabled,
    fastMode,
    modelOptions,
    selectedModelLabel: selectedLabel,
    selectedModelValue: currentOverride,
    selectedThinkingLabel,
    selectedThinkingValue: thinking.currentOverride,
    thinkingDefaultValue: thinking.defaultValue,
    thinkingDisabled,
    thinkingOptions: [{ value: "", label: thinking.defaultLabel }, ...thinking.options],
    onFastModeSelect: async (next) => callbacks.onFastModeSelect?.(next),
    onModelSelect: async (next) => callbacks.onModelSelect?.(next),
    onThinkingSelect: async (next) => callbacks.onThinkingSelect?.(next),
  });
}

function resolveThinkingTargetModel(state: ChatModelControlsState): {
  provider: string | null;
  model: string | null;
} {
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
  return {
    provider: activeRow?.modelProvider ?? state.sessionsResult?.defaults?.modelProvider ?? null,
    model: activeRow?.model ?? state.sessionsResult?.defaults?.model ?? null,
  };
}

function resolveProviderFromModelValue(
  value: string,
  catalog: ChatModelControlsState["chatModelCatalog"],
): string | null {
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

function resolveChatFastModeSelectState(
  state: ChatModelControlsState,
  currentModelOverride: string,
): ChatFastModeSelectState {
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
  const { provider } = resolveThinkingTargetModel(state);
  const effectiveProvider =
    resolveProviderFromModelValue(currentModelOverride, state.chatModelCatalog ?? []) ??
    provider?.trim().toLowerCase() ??
    null;
  const currentOverride =
    activeRow?.fastMode === "auto"
      ? "auto"
      : activeRow?.fastMode === true
        ? "on"
        : activeRow?.fastMode === false
          ? "off"
          : "";
  const supported = Boolean(
    (effectiveProvider && FAST_MODE_PROVIDER_IDS.has(effectiveProvider)) || currentOverride,
  );
  return {
    currentOverride,
    disabled:
      !supported ||
      !state.connected ||
      state.chatLoading ||
      state.chatSending ||
      Boolean(state.chatRunId) ||
      state.chatStream !== null ||
      !state.client,
    options: [
      { value: "", label: "Default" },
      { value: "on", label: "Fast" },
      { value: "off", label: "Standard" },
      { value: "auto", label: "Auto" },
    ],
    supported,
  };
}

function buildThinkingOptions(
  levels: readonly GatewayThinkingLevelOption[],
  currentOverride: string,
): ChatThinkingSelectOption[] {
  const seen = new Set<string>();
  const options: ChatThinkingSelectOption[] = [];
  const addOption = (value: string, label?: string) => {
    const normalizedValue = normalizeThinkingOptionValue(value);
    pushUniqueTrimmedSelectOption(options, seen, normalizedValue, () =>
      formatThinkingOverrideLabel(normalizedValue, label),
    );
  };

  for (const level of levels) {
    addOption(level.id, level.label);
  }
  if (currentOverride) {
    addOption(currentOverride);
  }
  return options;
}

function isOffThinkingOption(value: string | null | undefined): boolean {
  return normalizeThinkingOptionValue(value ?? "") === "off";
}

function isOffOnlyThinkingLevels(levels: readonly GatewayThinkingLevelOption[]): boolean {
  return levels.every((level) => isOffThinkingOption(level.id || level.label));
}

function resolveThinkingLevelOptions(
  activeRow: SessionsListResult["sessions"][number] | undefined,
  defaults: SessionsListResult["defaults"] | undefined,
  provider: string | null,
  model: string | null,
  catalog: readonly ThinkingCatalogEntry[],
): GatewayThinkingLevelOption[] {
  const modelMatchesDefaults = sessionModelMatchesDefaults(activeRow, defaults);
  const catalogEntry =
    provider && model
      ? catalog.find((entry) => entry.provider === provider && entry.id === model)
      : undefined;
  const explicitLevels =
    (activeRow?.thinkingLevels?.length ? activeRow.thinkingLevels : null) ??
    (modelMatchesDefaults && defaults?.thinkingLevels?.length ? defaults.thinkingLevels : null);
  if (explicitLevels) {
    if (catalogEntry?.reasoning === false && isOffOnlyThinkingLevels(explicitLevels)) {
      return [];
    }
    return explicitLevels;
  }
  const explicitLabels =
    (activeRow?.thinkingOptions?.length ? activeRow.thinkingOptions : null) ??
    (modelMatchesDefaults && defaults?.thinkingOptions?.length ? defaults.thinkingOptions : null);
  if (catalogEntry?.reasoning === false) {
    if (!explicitLabels || explicitLabels.every(isOffThinkingOption)) {
      return [];
    }
  }
  const labels =
    explicitLabels ??
    (provider && model ? listThinkingLevelLabels(provider, model) : listThinkingLevelLabels());
  return labels.map((label) => ({
    id: normalizeThinkLevel(label) ?? normalizeLowercaseStringOrEmpty(label),
    label,
  }));
}

export function resolveChatThinkingSelectState(
  state: ChatModelControlsState,
): ChatThinkingSelectState {
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
  const persisted = activeRow?.thinkingLevel;
  const currentOverride =
    typeof persisted === "string" && persisted.trim()
      ? (normalizeThinkLevel(persisted) ?? persisted.trim())
      : "";
  const defaults = state.sessionsResult?.defaults;
  const { provider, model } = resolveThinkingTargetModel(state);
  const levels = resolveThinkingLevelOptions(
    activeRow,
    defaults,
    provider,
    model,
    state.chatModelCatalog ?? [],
  );
  const defaultFromSessionDefaults =
    (!activeRow || sessionModelMatchesDefaults(activeRow, defaults)) && defaults?.thinkingDefault
      ? defaults.thinkingDefault
      : undefined;
  const defaultLevel =
    activeRow?.thinkingDefault ??
    defaultFromSessionDefaults ??
    (provider && model
      ? resolveThinkingDefaultForModel({
          provider,
          model,
          catalog: state.chatModelCatalog ?? [],
        })
      : "off");
  const effectiveOverride = levels.length === 0 && currentOverride === "off" ? "" : currentOverride;
  return {
    currentOverride: effectiveOverride,
    defaultLabel: formatInheritedThinkingLabel(defaultLevel),
    defaultValue: normalizeThinkingOptionValue(defaultLevel),
    options: buildThinkingOptions(levels, effectiveOverride),
  };
}

function formatCombinedPickerModelLabel(label: string): string {
  const match = /^Default \((.+)\)$/u.exec(label);
  return match?.[1] ?? label;
}

function formatCombinedPickerModelOptionLabel(
  option: ChatInlineSelectOption,
  selected: boolean,
): string {
  return option.value === "" && selected
    ? formatCombinedPickerModelLabel(option.label)
    : option.label;
}

function formatCombinedPickerThinkingLabel(label: string): string {
  return label.replace(/^Inherited:\s*/u, "");
}

function renderChatModelReasoningSelect(params: {
  fastMode: ChatFastModeSelectState;
  disabled: boolean;
  modelOptions: ChatInlineSelectOption[];
  selectedModelLabel: string;
  selectedModelValue: string;
  selectedThinkingLabel: string;
  selectedThinkingValue: string;
  thinkingDefaultValue: string;
  thinkingDisabled: boolean;
  thinkingOptions: ChatInlineSelectOption[];
  onFastModeSelect: (value: "" | "on" | "off" | "auto") => Promise<unknown>;
  onModelSelect: (value: string) => Promise<unknown>;
  onThinkingSelect: (value: string) => Promise<unknown>;
}) {
  const {
    disabled,
    fastMode,
    modelOptions,
    selectedModelLabel,
    selectedModelValue,
    selectedThinkingLabel,
    selectedThinkingValue,
    thinkingDefaultValue,
    thinkingDisabled,
    thinkingOptions,
    onFastModeSelect,
    onModelSelect,
    onThinkingSelect,
  } = params;
  const triggerModel = formatCombinedPickerModelLabel(selectedModelLabel);
  const triggerThinking = formatCombinedPickerThinkingLabel(selectedThinkingLabel);
  const triggerTitle = `${triggerModel} · ${triggerThinking}`;
  const triggerLabel =
    selectedThinkingValue === "" ? triggerModel : `${triggerModel} · ${triggerThinking}`;
  const sliderStops = thinkingOptions.filter((option) => option.value !== "");
  const defaultStopIndex = sliderStops.findIndex((option) => option.value === thinkingDefaultValue);
  const hasThinkingOverride = selectedThinkingValue !== "";
  const overrideStopIndex = sliderStops.findIndex(
    (option) => option.value === selectedThinkingValue,
  );
  const sliderIndex = Math.max(hasThinkingOverride ? overrideStopIndex : defaultStopIndex, 0);
  // Inherited defaults may not exist on the offered scale. Keep the label
  // truthful and leave the parked thumb visually unanchored.
  const sliderUnanchored = !hasThinkingOverride && defaultStopIndex < 0;
  const sliderFillPercent = (index: number) =>
    sliderStops.length > 1 ? (index / (sliderStops.length - 1)) * 100 : 0;
  const reasoningValueLabel = hasThinkingOverride
    ? triggerThinking
    : `Default (${triggerThinking})`;
  const defaultLevelLabel = formatThinkingOverrideLabel(thinkingDefaultValue);
  const onSliderDrag = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    input.style.setProperty("--reasoning-fill", `${sliderFillPercent(Number(input.value))}%`);
  };
  const onSliderCommit = async (event: Event) => {
    if (thinkingDisabled) {
      return;
    }
    const input = event.currentTarget as HTMLInputElement;
    const stop = sliderStops[Number(input.value)];
    if (!stop || stop.value === selectedThinkingValue) {
      return;
    }
    await onThinkingSelect(stop.value);
  };
  const showReasoning = sliderStops.length > 0;
  const onlyStop = sliderStops.length === 1 ? sliderStops[0] : undefined;
  const showReasoningPanel = showReasoning || fastMode.supported;
  return html`
    <details class="chat-controls__session chat-controls__inline-select chat-controls__model">
      <summary
        class="chat-controls__inline-select-trigger ${disabled
          ? "chat-controls__inline-select-trigger--disabled"
          : ""}"
        data-chat-model-select="true"
        data-chat-thinking-select="true"
        data-chat-select-value=${selectedModelValue}
        data-chat-thinking-value=${selectedThinkingValue}
        data-chat-thinking-disabled=${thinkingDisabled ? "true" : "false"}
        aria-label=${`${t("chat.selectors.model")}, ${t("chat.selectors.thinkingLevel")}: ${triggerTitle}`}
        aria-disabled=${disabled ? "true" : "false"}
        @click=${(event: MouseEvent) => {
          if (disabled) {
            event.preventDefault();
          }
        }}
      >
        <span class="chat-controls__inline-select-label">${triggerLabel}</span>
        <span class="chat-controls__inline-select-icon" aria-hidden="true">
          ${icons.chevronDown}
        </span>
      </summary>
      <div
        class="chat-controls__inline-select-menu chat-controls__inline-select-menu--combined"
        aria-label=${t("chat.selectors.model")}
      >
        <div class="chat-controls__inline-select-section-label">Model</div>
        <div class="chat-controls__combined-model-list">
          ${repeat(
            modelOptions,
            (entry) => entry.value,
            (entry) => {
              const selected = entry.value === selectedModelValue;
              return html`
                <div class="chat-controls__combined-model">
                  <button
                    class="chat-controls__inline-select-option chat-controls__combined-model-option ${selected
                      ? "chat-controls__inline-select-option--selected"
                      : ""}"
                    data-chat-model-option=${entry.value}
                    role="option"
                    aria-selected=${selected ? "true" : "false"}
                    type="button"
                    ?disabled=${disabled}
                    @click=${async (event: MouseEvent) => {
                      if (disabled || selected) {
                        event.preventDefault();
                        return;
                      }
                      (event.currentTarget as HTMLElement)
                        .closest("details")
                        ?.removeAttribute("open");
                      await onModelSelect(entry.value);
                    }}
                  >
                    <span>${formatCombinedPickerModelOptionLabel(entry, selected)}</span>
                    ${selected
                      ? html`<span
                          class="chat-controls__inline-select-check chat-controls__combined-model-arrow"
                          aria-hidden="true"
                        >
                          ${icons.chevronDown}
                        </span>`
                      : ""}
                  </button>
                </div>
              `;
            },
          )}
        </div>
        ${showReasoningPanel
          ? html`
              <div class="chat-controls__reasoning-panel">
                ${showReasoning
                  ? html`
                      <div class="chat-controls__reasoning-head">
                        <span class="chat-controls__inline-select-section-label">Reasoning</span>
                        <span class="chat-controls__reasoning-value">${reasoningValueLabel}</span>
                      </div>
                      ${sliderStops.length > 1
                        ? html`
                            <div class="chat-controls__reasoning-slider">
                              <div class="chat-controls__reasoning-dots" aria-hidden="true">
                                ${sliderStops.map(
                                  (stop, index) =>
                                    html`<span
                                      class="chat-controls__reasoning-dot ${index ===
                                      defaultStopIndex
                                        ? "chat-controls__reasoning-dot--default"
                                        : ""}"
                                      data-stop=${stop.value}
                                    ></span>`,
                                )}
                              </div>
                              <input
                                class="chat-controls__reasoning-range ${hasThinkingOverride
                                  ? ""
                                  : "chat-controls__reasoning-range--inherit"} ${sliderUnanchored
                                  ? "chat-controls__reasoning-range--unanchored"
                                  : ""}"
                                type="range"
                                min="0"
                                max=${sliderStops.length - 1}
                                step="1"
                                .value=${String(sliderIndex)}
                                style=${`--reasoning-fill: ${sliderFillPercent(sliderIndex)}%`}
                                data-chat-thinking-slider="true"
                                data-chat-thinking-values=${sliderStops
                                  .map((stop) => stop.value)
                                  .join(",")}
                                aria-label=${t("chat.selectors.thinkingLevel")}
                                aria-valuetext=${reasoningValueLabel}
                                ?disabled=${thinkingDisabled}
                                @input=${onSliderDrag}
                                @change=${onSliderCommit}
                              />
                            </div>
                            <div class="chat-controls__reasoning-scale" aria-hidden="true">
                              <span>Faster</span>
                              <span>Smarter</span>
                            </div>
                          `
                        : onlyStop
                          ? html`
                              <button
                                class="chat-controls__reasoning-option ${hasThinkingOverride
                                  ? "chat-controls__reasoning-option--selected"
                                  : ""}"
                                data-chat-thinking-option=${onlyStop.value}
                                type="button"
                                aria-pressed=${hasThinkingOverride ? "true" : "false"}
                                ?disabled=${thinkingDisabled}
                                @click=${async (event: MouseEvent) => {
                                  event.stopPropagation();
                                  if (thinkingDisabled || hasThinkingOverride) {
                                    event.preventDefault();
                                    return;
                                  }
                                  await onThinkingSelect(onlyStop.value);
                                }}
                              >
                                <span>${onlyStop.label}</span>
                                ${hasThinkingOverride
                                  ? html`<span
                                      class="chat-controls__inline-select-check"
                                      aria-hidden="true"
                                    >
                                      ${icons.check}
                                    </span>`
                                  : ""}
                              </button>
                            `
                          : ""}
                      ${hasThinkingOverride
                        ? html`
                            <button
                              class="chat-controls__reasoning-reset"
                              data-chat-thinking-option=""
                              type="button"
                              ?disabled=${thinkingDisabled}
                              @click=${async (event: MouseEvent) => {
                                event.stopPropagation();
                                if (thinkingDisabled) {
                                  event.preventDefault();
                                  return;
                                }
                                await onThinkingSelect("");
                              }}
                            >
                              Use default (${defaultLevelLabel})
                            </button>
                          `
                        : ""}
                    `
                  : ""}
                ${fastMode.supported
                  ? html`
                      <div class="chat-controls__inline-select-section-label">Speed</div>
                      <div class="chat-controls__reasoning-options" role="listbox">
                        ${repeat(
                          fastMode.options,
                          (speed) => speed.value,
                          (speed) => {
                            const speedValue = speed.value as "" | "on" | "off" | "auto";
                            const speedSelected = speedValue === fastMode.currentOverride;
                            return html`
                              <button
                                class="chat-controls__reasoning-option ${speedSelected
                                  ? "chat-controls__reasoning-option--selected"
                                  : ""}"
                                data-chat-speed-option=${speed.value}
                                role="option"
                                aria-selected=${speedSelected ? "true" : "false"}
                                type="button"
                                ?disabled=${fastMode.disabled}
                                @click=${async (event: MouseEvent) => {
                                  event.stopPropagation();
                                  if (fastMode.disabled) {
                                    event.preventDefault();
                                    return;
                                  }
                                  (event.currentTarget as HTMLElement)
                                    .closest("details")
                                    ?.removeAttribute("open");
                                  await onFastModeSelect(speedValue);
                                }}
                              >
                                <span>${speed.label}</span>
                                ${speedSelected
                                  ? html`<span
                                      class="chat-controls__inline-select-check"
                                      aria-hidden="true"
                                    >
                                      ${icons.check}
                                    </span>`
                                  : ""}
                              </button>
                            `;
                          },
                        )}
                      </div>
                    `
                  : ""}
              </div>
            `
          : ""}
      </div>
    </details>
  `;
}
