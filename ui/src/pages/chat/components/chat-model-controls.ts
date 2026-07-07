// Chat-owned model, reasoning, and speed picker.
import { html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type {
  GatewaySessionRow,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../../api/types.ts";
import { inferControlUiPublicAssetPath } from "../../../app/public-assets.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
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
  agentDefaultModel?: string;
  connected: boolean;
  draftScope: object;
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
  onFastModeSelect?: (value: ChatFastModeSelectValue, sessionKey: string) => unknown;
  onModelSelect?: (value: string, sessionKey: string) => unknown;
  onRequestUpdate?: () => void;
  onThinkingSelect?: (value: string, sessionKey: string) => unknown;
};

type ChatModelProviderOption = ChatModelSelectOption & {
  provider: string;
};

type ChatModelPickerDraft = {
  fastModeValue: ChatFastModeSelectValue;
  initialFastModeValue: ChatFastModeSelectValue;
  initialModelValue: string;
  initialThinkingValue: string;
  modelValue: string;
  saving: boolean;
  thinkingValue: string;
};

type ChatModelPickerDraftStore = {
  delete: () => void;
  get: () => ChatModelPickerDraft | undefined;
  set: (draft: ChatModelPickerDraft) => void;
};

type ChatModelPickerDraftContext = {
  draft?: ChatModelPickerDraft;
  sessionKey: string;
};

const chatModelPickerDraftContexts = new WeakMap<object, ChatModelPickerDraftContext>();

function resolveChatModelPickerDraftStore(
  scope: object,
  sessionKey: string,
): ChatModelPickerDraftStore {
  let context = chatModelPickerDraftContexts.get(scope);
  if (!context || context.sessionKey !== sessionKey) {
    context = { sessionKey };
    chatModelPickerDraftContexts.set(scope, context);
  }
  const activeContext = context;
  return {
    delete: () => {
      activeContext.draft = undefined;
    },
    get: () => activeContext.draft,
    set: (draft) => {
      activeContext.draft = draft;
    },
  };
}

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

const CHAT_MODEL_PROVIDER_ICON_NAMES = new Set([
  "abacus",
  "alibaba",
  "amp",
  "antigravity",
  "augment",
  "bedrock",
  "chutes",
  "claude",
  "clawrouter",
  "codebuff",
  "codex",
  "commandcode",
  "copilot",
  "crof",
  "crossmodel",
  "cursor",
  "deepgram",
  "deepseek",
  "devin",
  "doubao",
  "elevenlabs",
  "factory",
  "gemini",
  "grok",
  "groq",
  "jetbrains",
  "kilo",
  "kimi",
  "kiro",
  "litellm",
  "llmproxy",
  "manus",
  "mimo",
  "minimax",
  "mistral",
  "ollama",
  "opencode",
  "opencodego",
  "openrouter",
  "perplexity",
  "poe",
  "qoder",
  "sakana",
  "stepfun",
  "synthetic",
  "t3chat",
  "venice",
  "vertexai",
  "warp",
  "windsurf",
  "zai",
  "zed",
]);

const CHAT_MODEL_PROVIDER_ICON_ALIASES: Readonly<Record<string, string>> = {
  anthropic: "claude",
  "amazon-bedrock": "bedrock",
  "aws-bedrock": "bedrock",
  google: "gemini",
  "google-gemini-cli": "gemini",
  "github-copilot": "copilot",
  openai: "codex",
  "opencode-go": "opencodego",
  "opencode-zen": "opencode",
  xai: "grok",
  "vertex-ai": "vertexai",
  "z-ai": "zai",
};

function formatChatModelProviderLabel(provider: string): string {
  const known = CHAT_MODEL_PROVIDER_LABELS[provider];
  if (known) {
    return known;
  }
  return formatRawChatModelProviderLabel(provider);
}

function formatRawChatModelProviderLabel(provider: string): string {
  return provider
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function resolveChatModelProviderIcon(provider: string): string | null {
  const normalized = normalizeChatModelProviderId(provider);
  const icon = CHAT_MODEL_PROVIDER_ICON_ALIASES[normalized] ?? normalized;
  return CHAT_MODEL_PROVIDER_ICON_NAMES.has(icon) ? icon : null;
}

function renderChatModelProviderIcon(provider: string) {
  const icon = resolveChatModelProviderIcon(provider);
  if (!icon) {
    return html`
      <span
        class="chat-controls__provider-icon chat-controls__provider-icon--fallback"
        aria-hidden="true"
      >
        ${formatChatModelProviderLabel(provider).charAt(0)}
      </span>
    `;
  }
  const iconUrl = inferControlUiPublicAssetPath(`provider-icons/ProviderIcon-${icon}.svg`);
  return html`
    <span
      class="chat-controls__provider-icon"
      data-provider-icon=${icon}
      style=${`--provider-icon-url: url("${iconUrl}")`}
      aria-hidden="true"
    ></span>
  `;
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

function resolveChatModelTarget(params: {
  catalog: ModelCatalogEntry[];
  defaultModel: string;
  modelOptions: ChatModelProviderOption[];
  value: string;
}): { model: string | undefined; provider: string | undefined } {
  const targetValue = params.value || params.defaultModel;
  if (!targetValue) {
    return { model: undefined, provider: undefined };
  }
  const option = params.modelOptions.find((entry) => entry.value === params.value);
  const provider = option?.provider ?? resolveChatModelProvider(targetValue, params.catalog);
  const normalizedProvider = normalizeChatModelProviderGroupId(provider);
  const normalizedValue = targetValue.trim().toLowerCase();
  const catalogEntry = params.catalog.find((entry) => {
    const entryProvider = normalizeChatModelProviderId(entry.provider);
    const entryProviderGroup = normalizeChatModelProviderGroupId(entry.provider);
    const entryId = entry.id.trim().toLowerCase();
    return (
      entryProviderGroup === normalizedProvider &&
      (entryId === normalizedValue || `${entryProvider}/${entryId}` === normalizedValue)
    );
  });
  if (catalogEntry) {
    return {
      model: catalogEntry.id,
      provider: catalogEntry.provider,
    };
  }
  const separator = normalizedValue.indexOf("/");
  const qualifiedProvider =
    separator > 0 ? normalizeChatModelProviderGroupId(normalizedValue.slice(0, separator)) : "";
  return {
    model:
      separator > 0 && qualifiedProvider === normalizedProvider
        ? targetValue.slice(separator + 1)
        : targetValue,
    provider,
  };
}

function resolveDraftFastMode(value: ChatFastModeSelectValue): GatewaySessionRow["fastMode"] {
  if (value === "auto") {
    return "auto";
  }
  if (value === "on") {
    return true;
  }
  if (value === "off") {
    return false;
  }
  return undefined;
}

function applyChatModelPickerDraft(params: {
  catalog: ModelCatalogEntry[];
  defaultModel: string;
  draft: ChatModelPickerDraft | undefined;
  modelOptions: ChatModelProviderOption[];
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
}): SessionsListResult | null {
  if (!params.draft || !params.sessionsResult) {
    return params.sessionsResult;
  }
  const draft = params.draft;
  const sessionsResult = params.sessionsResult;
  const target = resolveChatModelTarget({
    catalog: params.catalog,
    defaultModel: params.defaultModel,
    modelOptions: params.modelOptions,
    value: draft.modelValue,
  });
  const fastMode = resolveDraftFastMode(draft.fastModeValue);
  return {
    ...sessionsResult,
    sessions: sessionsResult.sessions.map((row) =>
      row.key === params.sessionKey
        ? Object.assign({}, row, {
            model: target.model,
            modelProvider: target.provider,
            thinkingLevel: draft.thinkingValue || undefined,
            fastMode,
            effectiveFastMode: fastMode,
          })
        : row,
    ),
  };
}

function ensureChatModelPickerDraft(
  draftStore: ChatModelPickerDraftStore,
  params: {
    fastModeValue: ChatFastModeSelectValue;
    modelValue: string;
    sessionKey: string;
    thinkingValue: string;
  },
): ChatModelPickerDraft {
  const existing = draftStore.get();
  if (existing) {
    return existing;
  }
  const draft: ChatModelPickerDraft = {
    fastModeValue: params.fastModeValue,
    initialFastModeValue: params.fastModeValue,
    initialModelValue: params.modelValue,
    initialThinkingValue: params.thinkingValue,
    modelValue: params.modelValue,
    saving: false,
    thinkingValue: params.thinkingValue,
  };
  draftStore.set(draft);
  return draft;
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
  const draftStore = resolveChatModelPickerDraftStore(props.draftScope, props.sessionKey);
  const {
    currentOverride,
    defaultSelectable,
    defaultModel,
    defaultLabel,
    options: selectOptions,
  } = resolveChatModelSelectState({
    agentDefaultModel: props.agentDefaultModel,
    chatModelCatalog: props.modelCatalog,
    modelOverrides: props.modelOverrides ?? {},
    sessionKey: props.sessionKey,
    sessionsResult: props.sessionsResult,
  });
  const committedThinking = resolveChatThinkingSelectState({
    catalog: props.modelCatalog,
    sessionKey: props.sessionKey,
    sessionsResult: props.sessionsResult,
  });
  const committedFastMode = resolveChatFastModeSelectState({
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
  const committedModelLabel =
    modelOptions.find((entry) => entry.value === currentOverride)?.label ??
    resolveChatModelPickerLabel(
      currentOverride,
      currentOverride || pickerDefaultLabel,
      props.modelCatalog,
    );
  const committedThinkingLabel =
    committedThinking.currentOverride === ""
      ? committedThinking.defaultLabel
      : (committedThinking.options.find(
          (entry) => entry.value === committedThinking.currentOverride,
        )?.label ?? committedThinking.currentOverride);
  const draft = draftStore.get();
  const selectedModelValue = draft?.modelValue ?? currentOverride;
  const draftSessionsResult = applyChatModelPickerDraft({
    catalog: props.modelCatalog,
    defaultModel,
    draft,
    modelOptions,
    sessionKey: props.sessionKey,
    sessionsResult: props.sessionsResult,
  });
  const thinking = draft
    ? resolveChatThinkingSelectState({
        catalog: props.modelCatalog,
        sessionKey: props.sessionKey,
        sessionsResult: draftSessionsResult,
      })
    : committedThinking;
  const fastMode = draft
    ? {
        ...resolveChatFastModeSelectState({
          activeRunId: props.activeRunId,
          catalog: props.modelCatalog,
          connected: props.connected,
          currentModelOverride: selectedModelValue,
          gatewayAvailable: props.gatewayAvailable,
          loading: props.loading,
          sending: props.sending,
          sessionKey: props.sessionKey,
          sessionsResult: draftSessionsResult,
          stream: props.stream,
        }),
        currentOverride: draft.fastModeValue,
      }
    : committedFastMode;
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
  return renderChatModelReasoningSelect({
    disabled,
    draftStore,
    fastMode,
    modelOptions,
    initialFastModeValue: committedFastMode.currentOverride,
    initialModelValue: currentOverride,
    initialThinkingValue: committedThinking.currentOverride,
    onRequestUpdate: props.onRequestUpdate,
    selectedModelValue,
    selectedThinkingValue: thinking.currentOverride,
    sessionKey: props.sessionKey,
    thinkingDefaultValue: thinking.defaultValue,
    thinkingDisabled,
    thinkingOptions: [{ value: "", label: thinking.defaultLabel }, ...thinking.options],
    triggerModelLabel: committedModelLabel,
    triggerThinkingLabel: committedThinkingLabel,
    onFastModeSelect: async (next, targetSessionKey) =>
      props.onFastModeSelect?.(next, targetSessionKey),
    onModelSelect: async (next, targetSessionKey) => props.onModelSelect?.(next, targetSessionKey),
    onThinkingSelect: async (next, targetSessionKey) =>
      props.onThinkingSelect?.(next, targetSessionKey),
  });
}

function formatCombinedPickerModelLabel(label: string): string {
  const match = /^Default \((.+)\)$/u.exec(label);
  return match?.[1] ?? label;
}

function formatCombinedPickerModelOptionLabel(
  option: ChatModelProviderOption,
  selected: boolean,
): string {
  const label =
    option.value === "" && selected ? formatCombinedPickerModelLabel(option.label) : option.label;
  const providerPrefixes = [
    formatRawChatModelProviderLabel(option.provider),
    formatChatModelProviderLabel(option.provider),
  ].toSorted((left, right) => right.length - left.length);
  for (const prefix of providerPrefixes) {
    if (label.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) {
      return label.slice(prefix.length + 1);
    }
  }
  return label;
}

function formatCombinedPickerThinkingLabel(label: string): string {
  return label.replace(/^Inherited:\s*/u, "");
}

function renderChatModelReasoningSelect(params: {
  draftStore: ChatModelPickerDraftStore;
  fastMode: ChatFastModeSelectState;
  disabled: boolean;
  initialFastModeValue: ChatFastModeSelectValue;
  initialModelValue: string;
  initialThinkingValue: string;
  modelOptions: ChatModelProviderOption[];
  selectedModelValue: string;
  selectedThinkingValue: string;
  sessionKey: string;
  thinkingDefaultValue: string;
  thinkingDisabled: boolean;
  thinkingOptions: ChatModelSelectOption[];
  triggerModelLabel: string;
  triggerThinkingLabel: string;
  onFastModeSelect: (value: ChatFastModeSelectValue, sessionKey: string) => Promise<unknown>;
  onModelSelect: (value: string, sessionKey: string) => Promise<unknown>;
  onRequestUpdate?: () => void;
  onThinkingSelect: (value: string, sessionKey: string) => Promise<unknown>;
}) {
  const {
    disabled,
    draftStore,
    fastMode,
    initialFastModeValue,
    initialModelValue,
    initialThinkingValue,
    modelOptions,
    selectedModelValue,
    selectedThinkingValue,
    sessionKey,
    thinkingDefaultValue,
    thinkingDisabled,
    thinkingOptions,
    triggerModelLabel,
    triggerThinkingLabel,
    onFastModeSelect,
    onModelSelect,
    onRequestUpdate,
    onThinkingSelect,
  } = params;
  const triggerModel = formatCombinedPickerModelLabel(triggerModelLabel);
  const triggerThinking = formatCombinedPickerThinkingLabel(triggerThinkingLabel);
  const triggerTitle = `${triggerModel} · ${triggerThinking}`;
  const triggerLabel = triggerTitle;
  const sliderStops = thinkingOptions.filter((option) => option.value !== "");
  const defaultStopIndex = sliderStops.findIndex((option) => option.value === thinkingDefaultValue);
  const hasThinkingOverride = selectedThinkingValue !== "";
  const overrideStopIndex = sliderStops.findIndex(
    (option) => option.value === selectedThinkingValue,
  );
  const sliderIndex = Math.max(hasThinkingOverride ? overrideStopIndex : defaultStopIndex, 0);
  const sliderUnanchored = !hasThinkingOverride && defaultStopIndex < 0;
  const sliderFillPercent = (index: number) =>
    sliderStops.length > 1 ? (index / (sliderStops.length - 1)) * 100 : 0;
  const defaultLevelLabel = formatThinkingOverrideLabel(thinkingDefaultValue);
  const selectedThinkingOption = thinkingOptions.find(
    (option) => option.value === selectedThinkingValue,
  );
  const reasoningValueLabel = hasThinkingOverride
    ? formatCombinedPickerThinkingLabel(
        selectedThinkingOption?.label ?? formatThinkingOverrideLabel(selectedThinkingValue),
      )
    : `Default (${defaultLevelLabel})`;
  const onSliderDrag = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const stop = sliderStops[Number(input.value)];
    if (!stop) {
      return;
    }
    const draft = ensureChatModelPickerDraft(draftStore, {
      fastModeValue: initialFastModeValue,
      modelValue: initialModelValue,
      sessionKey,
      thinkingValue: initialThinkingValue,
    });
    draft.thinkingValue = stop.value;
    input.style.setProperty("--reasoning-fill", `${sliderFillPercent(Number(input.value))}%`);
    onRequestUpdate?.();
  };
  const onSliderCommit = (event: Event) => {
    if (thinkingDisabled) {
      return;
    }
    const input = event.currentTarget as HTMLInputElement;
    const stop = sliderStops[Number(input.value)];
    if (!stop || stop.value === selectedThinkingValue) {
      return;
    }
    const draft = ensureChatModelPickerDraft(draftStore, {
      fastModeValue: initialFastModeValue,
      modelValue: initialModelValue,
      sessionKey,
      thinkingValue: initialThinkingValue,
    });
    draft.thinkingValue = stop.value;
    onRequestUpdate?.();
  };
  const onUnanchoredSliderClick = (event: MouseEvent) => {
    const input = event.currentTarget as HTMLInputElement;
    if (!sliderUnanchored || Number(input.value) !== sliderIndex) {
      return;
    }
    onSliderCommit(event);
  };
  const onUnanchoredSliderKeyDown = (event: KeyboardEvent) => {
    if (!sliderUnanchored || !["Home", "ArrowLeft", "ArrowDown", "PageDown"].includes(event.key)) {
      return;
    }
    onSliderCommit(event);
  };
  const showReasoning = sliderStops.length > 0;
  const onlyStop = sliderStops.length === 1 ? sliderStops[0] : undefined;
  const effectiveThinkingValue = selectedThinkingValue || thinkingDefaultValue;
  const onlyStopSelected = onlyStop?.value === effectiveThinkingValue;
  const showReasoningPanel = showReasoning || fastMode.options.length > 0;
  const shouldDisableSave = () => {
    const draft = draftStore.get();
    return Boolean(
      disabled ||
      draft?.saving ||
      (draft && draft.thinkingValue !== draft.initialThinkingValue && thinkingDisabled) ||
      (draft && draft.fastModeValue !== draft.initialFastModeValue && fastMode.disabled),
    );
  };
  const providerGroups = new Map<string, ChatModelProviderOption[]>();
  for (const option of modelOptions) {
    if (option.value === "") {
      continue;
    }
    const existing = providerGroups.get(option.provider);
    if (existing) {
      existing.push(option);
    } else {
      providerGroups.set(option.provider, [option]);
    }
  }
  const defaultModelOption = modelOptions.find((option) => option.value === "");
  const orderedProviderGroups = [...providerGroups];
  const defaultProviderIndex = orderedProviderGroups.findIndex(
    ([provider]) => provider === defaultModelOption?.provider,
  );
  if (defaultProviderIndex > 0) {
    const [defaultProviderGroup] = orderedProviderGroups.splice(defaultProviderIndex, 1);
    if (defaultProviderGroup) {
      orderedProviderGroups.unshift(defaultProviderGroup);
    }
  }
  const selectedModelProvider =
    modelOptions.find((option) => option.value === selectedModelValue)?.provider ??
    modelOptions[0]?.provider ??
    "other";
  const selectedProvider =
    selectedModelValue === ""
      ? (orderedProviderGroups[0]?.[0] ?? selectedModelProvider)
      : selectedModelProvider;
  const renderModelOption = (entry: ChatModelProviderOption) => {
    const selected = entry.value === selectedModelValue;
    const modelLabel = formatCombinedPickerModelOptionLabel(entry, selected);
    return html`
      <div class="chat-controls__combined-model">
        <openclaw-tooltip .content=${modelLabel}>
          <button
            class="chat-controls__inline-select-option chat-controls__combined-model-option ${selected
              ? "chat-controls__inline-select-option--selected"
              : ""}"
            data-chat-model-option=${entry.value}
            role="option"
            aria-selected=${selected ? "true" : "false"}
            type="button"
            ?disabled=${disabled}
            @click=${(event: MouseEvent) => {
              event.stopPropagation();
              if (disabled || selected) {
                event.preventDefault();
                return;
              }
              const draft = ensureChatModelPickerDraft(draftStore, {
                fastModeValue: initialFastModeValue,
                modelValue: initialModelValue,
                sessionKey,
                thinkingValue: initialThinkingValue,
              });
              draft.modelValue = entry.value;
              onRequestUpdate?.();
            }}
          >
            <span class="chat-controls__model-option-copy">
              <span class="chat-controls__model-option-title">${modelLabel}</span>
              <span class="chat-controls__model-option-provider">
                ${formatChatModelProviderLabel(entry.provider)}
              </span>
            </span>
            <span
              class="chat-controls__inline-select-check"
              aria-hidden="true"
              ?hidden=${!selected}
            >
              ${icons.check}
            </span>
          </button>
        </openclaw-tooltip>
      </div>
    `;
  };
  return html`
    <details
      class="chat-controls__session chat-controls__inline-select chat-controls__model"
      @toggle=${(event: Event) => {
        const details = event.currentTarget as HTMLDetailsElement;
        if (details.open) {
          ensureChatModelPickerDraft(draftStore, {
            fastModeValue: initialFastModeValue,
            modelValue: initialModelValue,
            sessionKey,
            thinkingValue: initialThinkingValue,
          });
          return;
        }
        const draft = draftStore.get();
        if (!draft?.saving) {
          draftStore.delete();
          onRequestUpdate?.();
        }
      }}
    >
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
        <div class="chat-controls__model-browser">
          <div class="chat-controls__provider-list" aria-label=${t("sessionsView.provider")}>
            <div class="chat-controls__inline-select-section-label">
              ${t("sessionsView.provider")}
            </div>
            ${repeat(
              orderedProviderGroups,
              ([provider]) => provider,
              ([provider]) => {
                const active = provider === selectedProvider;
                return html`
                  <button
                    class="chat-controls__provider-option"
                    data-chat-model-provider=${provider}
                    type="button"
                    aria-pressed=${active ? "true" : "false"}
                    @click=${(event: MouseEvent) => selectChatModelProvider(event, provider)}
                  >
                    ${renderChatModelProviderIcon(provider)}
                    <span>${formatChatModelProviderLabel(provider)}</span>
                  </button>
                `;
              },
            )}
          </div>
          <div class="chat-controls__provider-models">
            ${repeat(
              orderedProviderGroups,
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
                    (entry) => renderModelOption(entry),
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
                        <div class="chat-controls__reasoning-heading">
                          <span class="chat-controls__inline-select-section-label">Reasoning</span>
                          <button
                            class="chat-controls__reasoning-default"
                            data-chat-thinking-option=""
                            type="button"
                            aria-label=${`Use default reasoning (${defaultLevelLabel})`}
                            ?disabled=${thinkingDisabled || !hasThinkingOverride}
                            @click=${(event: MouseEvent) => {
                              event.stopPropagation();
                              if (thinkingDisabled || !hasThinkingOverride) {
                                event.preventDefault();
                                return;
                              }
                              const draft = ensureChatModelPickerDraft(draftStore, {
                                fastModeValue: initialFastModeValue,
                                modelValue: initialModelValue,
                                sessionKey,
                                thinkingValue: initialThinkingValue,
                              });
                              draft.thinkingValue = "";
                              onRequestUpdate?.();
                            }}
                          >
                            (Default is ${defaultLevelLabel})
                          </button>
                        </div>
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
                                @click=${onUnanchoredSliderClick}
                                @keydown=${onUnanchoredSliderKeyDown}
                              />
                            </div>
                            <div class="chat-controls__reasoning-scale" aria-hidden="true">
                              <span>${t("chat.modelPicker.faster")}</span>
                              <span>${t("chat.modelPicker.smarter")}</span>
                            </div>
                          `
                        : onlyStop
                          ? html`
                              <button
                                class="chat-controls__reasoning-option ${onlyStopSelected
                                  ? "chat-controls__reasoning-option--selected"
                                  : ""}"
                                data-chat-thinking-option=${onlyStop.value}
                                type="button"
                                aria-pressed=${onlyStopSelected ? "true" : "false"}
                                ?disabled=${thinkingDisabled}
                                @click=${(event: MouseEvent) => {
                                  event.stopPropagation();
                                  if (thinkingDisabled || onlyStopSelected) {
                                    event.preventDefault();
                                    return;
                                  }
                                  const draft = ensureChatModelPickerDraft(draftStore, {
                                    fastModeValue: initialFastModeValue,
                                    modelValue: initialModelValue,
                                    sessionKey,
                                    thinkingValue: initialThinkingValue,
                                  });
                                  draft.thinkingValue = onlyStop.value;
                                  onRequestUpdate?.();
                                }}
                              >
                                <span>${onlyStop.label}</span>
                                ${onlyStopSelected
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
                          @click=${(event: MouseEvent) => {
                            event.stopPropagation();
                            if (fastMode.disabled) {
                              event.preventDefault();
                              return;
                            }
                            const draft = ensureChatModelPickerDraft(draftStore, {
                              fastModeValue: initialFastModeValue,
                              modelValue: initialModelValue,
                              sessionKey,
                              thinkingValue: initialThinkingValue,
                            });
                            draft.fastModeValue = speedValue;
                            const currentButton = event.currentTarget as HTMLButtonElement;
                            currentButton
                              .closest(".chat-controls__reasoning-options--speed")
                              ?.querySelectorAll<HTMLButtonElement>("[data-chat-speed-option]")
                              .forEach((button) => {
                                const selected =
                                  button.dataset.chatSpeedOption === draft.fastModeValue;
                                button.setAttribute("aria-pressed", selected ? "true" : "false");
                                button.classList.toggle(
                                  "chat-controls__reasoning-option--selected",
                                  selected,
                                );
                              });
                            onRequestUpdate?.();
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
        <div class="chat-controls__picker-actions">
          ${defaultModelOption
            ? html`
                <button
                  class="btn btn--sm chat-controls__use-default-model"
                  type="button"
                  ?disabled=${disabled || draftStore.get()?.saving || selectedModelValue === ""}
                  @click=${(event: MouseEvent) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (disabled || draftStore.get()?.saving || selectedModelValue === "") {
                      return;
                    }
                    const draft = ensureChatModelPickerDraft(draftStore, {
                      fastModeValue: initialFastModeValue,
                      modelValue: initialModelValue,
                      sessionKey,
                      thinkingValue: initialThinkingValue,
                    });
                    draft.modelValue = "";
                    onRequestUpdate?.();
                  }}
                >
                  ${t("chat.modelPicker.useDefaultModel")}
                </button>
              `
            : ""}
          <button
            class="btn btn--sm chat-controls__discard"
            type="button"
            ?disabled=${draftStore.get()?.saving}
            @click=${(event: MouseEvent) => {
              event.preventDefault();
              event.stopPropagation();
              draftStore.delete();
              (event.currentTarget as HTMLElement).closest("details")?.removeAttribute("open");
              onRequestUpdate?.();
            }}
          >
            ${t("chat.modelPicker.discard")}
          </button>
          <button
            class="btn btn--sm primary"
            type="button"
            ?disabled=${shouldDisableSave()}
            @click=${async (event: MouseEvent) => {
              event.preventDefault();
              event.stopPropagation();
              if (shouldDisableSave()) {
                return;
              }
              const details = (event.currentTarget as HTMLElement).closest("details");
              const draft = ensureChatModelPickerDraft(draftStore, {
                fastModeValue: initialFastModeValue,
                modelValue: initialModelValue,
                sessionKey,
                thinkingValue: initialThinkingValue,
              });
              if (draft.saving) {
                return;
              }
              draft.saving = true;
              details?.removeAttribute("open");
              onRequestUpdate?.();
              try {
                if (draft.modelValue !== draft.initialModelValue) {
                  const switched = await onModelSelect(draft.modelValue, sessionKey);
                  if (switched === false) {
                    return;
                  }
                }
                if (draft.thinkingValue !== draft.initialThinkingValue) {
                  const switched = await onThinkingSelect(draft.thinkingValue, sessionKey);
                  if (switched === false) {
                    return;
                  }
                }
                if (draft.fastModeValue !== draft.initialFastModeValue) {
                  const switched = await onFastModeSelect(draft.fastModeValue, sessionKey);
                  if (switched === false) {
                    return;
                  }
                }
                draftStore.delete();
              } finally {
                const current = draftStore.get();
                if (current === draft) {
                  current.saving = false;
                }
                onRequestUpdate?.();
              }
            }}
          >
            ${t("common.save")}
          </button>
        </div>
      </div>
    </details>
  `;
}
