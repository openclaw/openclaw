// Chat-owned model, reasoning, and speed picker.
import { html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { ModelCatalogEntry, SessionsListResult } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { normalizeChatModelProviderId } from "../../../lib/chat/model-ref.ts";
import {
  resolveChatFastModeSelectState,
  resolveChatModelSelectState,
  type ChatFastModeSelectState,
  type ChatFastModeSelectValue,
  type ChatModelSelectOption,
} from "../../../lib/chat/model-select-state.ts";
import {
  formatThinkingOverrideLabel,
  resolveChatThinkingSelectState,
} from "../../../lib/chat/thinking.ts";

export type ChatModelControlsProps = {
  activeRunId: string | null;
  connected: boolean;
  gatewayAvailable: boolean;
  loading: boolean;
  modelCatalog: ModelCatalogEntry[];
  modelOverrides?: Readonly<Record<string, string | null | undefined>>;
  modelSwitching: boolean;
  modelsLoading?: boolean;
  sending: boolean;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
  stream: string | null;
  onFastModeSelect?: (value: ChatFastModeSelectValue) => unknown;
  onModelSelect?: (value: string) => unknown;
  onThinkingSelect?: (value: string) => unknown;
};

type ChatModelProviderOption = ChatModelSelectOption & {
  provider: string;
};

const CHAT_MODEL_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  google: "Google",
  "github-copilot": "GitHub",
  openai: "OpenAI",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
};

const CHAT_MODEL_PROVIDER_GROUP_ALIASES: Readonly<Record<string, string>> = {
  "google-gemini-cli": "google",
  "opencode-go": "opencode",
  "opencode-zen": "opencode",
};

function normalizeChatModelProviderGroupId(provider: string): string {
  const normalized = normalizeChatModelProviderId(provider);
  return CHAT_MODEL_PROVIDER_GROUP_ALIASES[normalized] ?? normalized;
}

function formatChatModelProviderLabel(provider: string): string {
  const known = CHAT_MODEL_PROVIDER_LABELS[provider];
  if (known) {
    return known;
  }
  return provider
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function resolveChatModelProvider(
  value: string,
  catalog: ModelCatalogEntry[],
  fallbackValue = "",
  providerHint = "",
): string {
  const modelRef = (value || fallbackValue).trim();
  const normalizedModelRef = modelRef.toLowerCase();
  const qualifiedCatalogEntry = catalog.find((entry) => {
    const normalizedId = entry.id.trim().toLowerCase();
    const normalizedProvider = normalizeChatModelProviderId(entry.provider);
    return `${normalizedProvider}/${normalizedId}` === normalizedModelRef;
  });
  if (qualifiedCatalogEntry) {
    return normalizeChatModelProviderGroupId(qualifiedCatalogEntry.provider);
  }
  const idMatches = catalog.filter((entry) => entry.id.trim().toLowerCase() === normalizedModelRef);
  const normalizedHint = normalizeChatModelProviderId(providerHint);
  const hintOwnsRawId = idMatches.some(
    (entry) => normalizeChatModelProviderId(entry.provider) === normalizedHint,
  );
  if (normalizedHint && (idMatches.length === 0 || hintOwnsRawId)) {
    return normalizeChatModelProviderGroupId(normalizedHint);
  }
  if (idMatches.length === 1) {
    return normalizeChatModelProviderGroupId(idMatches[0]?.provider ?? "");
  }
  const separator = modelRef.indexOf("/");
  if (separator > 0) {
    return normalizeChatModelProviderGroupId(modelRef.slice(0, separator));
  }
  return "other";
}

function resolveChatModelPickerLabel(
  value: string,
  fallbackLabel: string,
  catalog: ModelCatalogEntry[],
): string {
  const trimmedValue = value.trim().toLowerCase();
  const separator = trimmedValue.indexOf("/");
  const normalizedValue =
    separator > 0
      ? `${normalizeChatModelProviderId(trimmedValue.slice(0, separator))}/${trimmedValue.slice(
          separator + 1,
        )}`
      : trimmedValue;
  if (!normalizedValue) {
    return fallbackLabel;
  }
  const matches = catalog.filter((candidate) => {
    const provider = normalizeChatModelProviderId(candidate.provider);
    return `${provider}/${candidate.id.trim().toLowerCase()}` === normalizedValue;
  });
  const entry =
    matches.find((candidate) => candidate.provider.trim().toLowerCase() === "openai") ?? matches[0];
  if (entry && normalizeChatModelProviderId(entry.provider) === "openai") {
    return entry.name.trim() || fallbackLabel;
  }
  return fallbackLabel;
}

function selectChatModelProvider(event: MouseEvent, provider: string): void {
  event.preventDefault();
  event.stopPropagation();
  const menu = (event.currentTarget as HTMLElement).closest(
    ".chat-controls__inline-select-menu--combined",
  );
  if (!(menu instanceof HTMLElement)) {
    return;
  }
  menu.querySelectorAll<HTMLElement>("[data-chat-model-provider]").forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      button.dataset.chatModelProvider === provider ? "true" : "false",
    );
  });
  menu.querySelectorAll<HTMLElement>("[data-chat-model-provider-group]").forEach((group) => {
    group.hidden = group.dataset.chatModelProviderGroup !== provider;
  });
}

export function renderChatModelControls(props: ChatModelControlsProps) {
  const {
    currentOverride,
    defaultSelectable,
    defaultModel,
    defaultLabel,
    options: selectOptions,
  } = resolveChatModelSelectState({
    chatModelCatalog: props.modelCatalog,
    modelOverrides: props.modelOverrides ?? {},
    sessionKey: props.sessionKey,
    sessionsResult: props.sessionsResult,
  });
  const thinking = resolveChatThinkingSelectState({
    catalog: props.modelCatalog,
    sessionKey: props.sessionKey,
    sessionsResult: props.sessionsResult,
  });
  const fastMode = resolveChatFastModeSelectState({
    activeRunId: props.activeRunId,
    catalog: props.modelCatalog,
    connected: props.connected,
    currentModelOverride: currentOverride,
    gatewayAvailable: props.gatewayAvailable,
    loading: props.loading,
    sending: props.sending,
    sessionKey: props.sessionKey,
    sessionsResult: props.sessionsResult,
    stream: props.stream,
  });
  const busy =
    props.loading || props.sending || Boolean(props.activeRunId) || props.stream !== null;
  const disabled =
    !props.connected ||
    busy ||
    props.modelSwitching ||
    (props.modelsLoading && selectOptions.length === 0) ||
    !props.gatewayAvailable;
  const thinkingDisabled =
    !props.connected ||
    busy ||
    !props.gatewayAvailable ||
    (thinking.options.length === 0 && thinking.currentOverride === "");
  const selectedThinkingLabel =
    thinking.currentOverride === ""
      ? thinking.defaultLabel
      : (thinking.options.find((entry) => entry.value === thinking.currentOverride)?.label ??
        thinking.currentOverride);
  const activeSession = props.sessionsResult?.sessions.find((row) => row.key === props.sessionKey);
  const currentProviderHint = activeSession?.modelProvider ?? "";
  const defaultProviderHint = props.sessionsResult?.defaults?.modelProvider ?? "";
  const canonicalDefaultLabel = resolveChatModelPickerLabel(
    defaultModel,
    defaultLabel,
    props.modelCatalog,
  );
  const pickerDefaultLabel =
    defaultModel && canonicalDefaultLabel !== defaultLabel
      ? `Default (${canonicalDefaultLabel})`
      : defaultLabel;
  const modelOptions: ChatModelProviderOption[] = [
    ...(defaultSelectable
      ? [
          {
            value: "",
            label: pickerDefaultLabel,
            provider: resolveChatModelProvider(
              "",
              props.modelCatalog,
              defaultModel,
              defaultProviderHint,
            ),
          },
        ]
      : []),
    ...selectOptions.map((option) => ({
      value: option.value,
      label: resolveChatModelPickerLabel(option.value, option.label, props.modelCatalog),
      provider: resolveChatModelProvider(
        option.value,
        props.modelCatalog,
        "",
        option.value === currentOverride ? currentProviderHint : "",
      ),
    })),
  ];
  const selectedLabel =
    modelOptions.find((entry) => entry.value === currentOverride)?.label ??
    resolveChatModelPickerLabel(
      currentOverride,
      currentOverride || pickerDefaultLabel,
      props.modelCatalog,
    );

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
    onFastModeSelect: async (next) => props.onFastModeSelect?.(next),
    onModelSelect: async (next) => props.onModelSelect?.(next),
    onThinkingSelect: async (next) => props.onThinkingSelect?.(next),
  });
}

function formatCombinedPickerModelLabel(label: string): string {
  const match = /^Default \((.+)\)$/u.exec(label);
  return match?.[1] ?? label;
}

function formatCombinedPickerModelOptionLabel(
  option: ChatModelSelectOption,
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
  modelOptions: ChatModelProviderOption[];
  selectedModelLabel: string;
  selectedModelValue: string;
  selectedThinkingLabel: string;
  selectedThinkingValue: string;
  thinkingDefaultValue: string;
  thinkingDisabled: boolean;
  thinkingOptions: ChatModelSelectOption[];
  onFastModeSelect: (value: ChatFastModeSelectValue) => Promise<unknown>;
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
  const thinkingStops = thinkingOptions.filter((option) => option.value !== "");
  const hasThinkingOverride = selectedThinkingValue !== "";
  const effectiveThinkingValue = selectedThinkingValue || thinkingDefaultValue;
  const reasoningValueLabel = hasThinkingOverride
    ? triggerThinking
    : `Default (${triggerThinking})`;
  const defaultLevelLabel = formatThinkingOverrideLabel(thinkingDefaultValue);
  const showReasoning = thinkingStops.length > 0;
  const showReasoningPanel = showReasoning || fastMode.options.length > 0;
  const providerGroups = new Map<string, ChatModelProviderOption[]>();
  for (const option of modelOptions) {
    const existing = providerGroups.get(option.provider);
    if (existing) {
      existing.push(option);
    } else {
      providerGroups.set(option.provider, [option]);
    }
  }
  const selectedProvider =
    modelOptions.find((option) => option.value === selectedModelValue)?.provider ??
    modelOptions[0]?.provider ??
    "other";
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
        <span class="chat-controls__inline-select-label">${triggerModel}</span>
        ${showReasoning || hasThinkingOverride
          ? html`<span
              class="chat-controls__effort-chip ${hasThinkingOverride
                ? "chat-controls__effort-chip--override"
                : ""}"
              aria-hidden="true"
              >${triggerThinking}</span
            >`
          : ""}
        <span class="chat-controls__inline-select-icon" aria-hidden="true">
          ${icons.chevronDown}
        </span>
      </summary>
      <div
        class="chat-controls__inline-select-menu chat-controls__inline-select-menu--combined"
        aria-label=${t("chat.selectors.model")}
      >
        <div class="chat-controls__model-browser">
          <div class="chat-controls__provider-list" aria-label=${t("sessionsView.provider")}>
            <div class="chat-controls__inline-select-section-label">
              ${t("sessionsView.provider")}
            </div>
            ${repeat(
              [...providerGroups.keys()],
              (provider) => provider,
              (provider) => {
                const active = provider === selectedProvider;
                return html`
                  <button
                    class="chat-controls__provider-option"
                    data-chat-model-provider=${provider}
                    type="button"
                    aria-pressed=${active ? "true" : "false"}
                    @click=${(event: MouseEvent) => selectChatModelProvider(event, provider)}
                  >
                    ${formatChatModelProviderLabel(provider)}
                  </button>
                `;
              },
            )}
          </div>
          <div class="chat-controls__provider-models">
            ${repeat(
              [...providerGroups],
              ([provider]) => provider,
              ([provider, options]) => html`
                <div
                  class="chat-controls__provider-model-group"
                  data-chat-model-provider-group=${provider}
                  aria-label=${`${formatChatModelProviderLabel(provider)} models`}
                  ?hidden=${provider !== selectedProvider}
                >
                  ${repeat(
                    options,
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
                            <span class="chat-controls__model-option-icon" aria-hidden="true">
                              ${icons.brain}
                            </span>
                            <span class="chat-controls__model-option-copy">
                              <span class="chat-controls__model-option-title">
                                ${formatCombinedPickerModelOptionLabel(entry, selected)}
                              </span>
                              <span class="chat-controls__model-option-provider">
                                ${formatChatModelProviderLabel(entry.provider)}
                              </span>
                            </span>
                            ${selected
                              ? html`
                                  <span
                                    class="chat-controls__inline-select-check"
                                    aria-hidden="true"
                                  >
                                    ${icons.check}
                                  </span>
                                `
                              : ""}
                          </button>
                        </div>
                      `;
                    },
                  )}
                </div>
              `,
            )}
          </div>
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
                      <div
                        class="chat-controls__reasoning-options chat-controls__reasoning-options--thinking"
                        data-chat-thinking-options="true"
                        role="group"
                        aria-label=${t("chat.selectors.thinkingLevel")}
                      >
                        ${repeat(
                          thinkingStops,
                          (stop) => stop.value,
                          (stop) => {
                            const selected = stop.value === effectiveThinkingValue;
                            return html`
                              <button
                                class="chat-controls__reasoning-option ${selected
                                  ? "chat-controls__reasoning-option--selected"
                                  : ""}"
                                data-chat-thinking-option=${stop.value}
                                type="button"
                                aria-pressed=${selected ? "true" : "false"}
                                ?disabled=${thinkingDisabled}
                                @click=${async (event: MouseEvent) => {
                                  event.stopPropagation();
                                  if (thinkingDisabled || selected) {
                                    event.preventDefault();
                                    return;
                                  }
                                  await onThinkingSelect(stop.value);
                                }}
                              >
                                <span>${stop.label}</span>
                              </button>
                            `;
                          },
                        )}
                      </div>
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
                <div class="chat-controls__inline-select-section-label">Speed</div>
                <div
                  class="chat-controls__reasoning-options chat-controls__reasoning-options--speed"
                  role="group"
                  aria-label="Speed"
                >
                  ${repeat(
                    fastMode.options,
                    (speed) => speed.value,
                    (speed) => {
                      const speedValue = speed.value as ChatFastModeSelectValue;
                      const speedSelected = speedValue === fastMode.currentOverride;
                      return html`
                        <button
                          class="chat-controls__reasoning-option ${speedSelected
                            ? "chat-controls__reasoning-option--selected"
                            : ""}"
                          data-chat-speed-option=${speed.value}
                          aria-pressed=${speedSelected ? "true" : "false"}
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
                        </button>
                      `;
                    },
                  )}
                </div>
              </div>
            `
          : ""}
      </div>
    </details>
  `;
}
