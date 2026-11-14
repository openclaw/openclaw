import type { ModelCatalogEntry } from "../../../api/types.ts";
import type { ProviderPresentation } from "../../../components/provider-icon-data.ts";
import {
  formatRawProviderLabel,
  providerDisplayLabel,
} from "../../../components/provider-icon-data.ts";
import { t } from "../../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import { formatContextTokenCapacity } from "../../../lib/format.ts";
import type { ChatContextWindowControlParams } from "./chat-context-window-control.tsx";

registerModelControlsEnglish();

export type ChatModelPickerOption = {
  /** Configured provider branding from the admitted catalog row. */
  presentation?: ProviderPresentation;
  agentRuntimeId?: string;
  /** Null is an unknown configured base; undefined is an ordinary model-only row. Both clear a prior pin. */
  agentRuntime?: string | null;
  /** Only explicit alternatives pin a runtime; configured base rows follow current routing. */
  runtimeOverride?: string;
  commitValue: string;
  contextTokens?: number;
  contextWindow?: number;
  disabled?: boolean;
  unavailableReason?: ModelCatalogEntry["unavailableReason"];
  unavailableUntil?: number;
  isDefault: boolean;
  label: string;
  provider: string;
  /** Hosted-catalog recommendation; the rest of its provider collapses under "All models". */
  recommended?: boolean;
  supportsTools?: boolean;
  value: string;
};

export function modelCooldownDeadline(
  options: readonly ChatModelPickerOption[],
): number | undefined {
  return options.reduce<number | undefined>((soonest, option) => {
    const until = option.unavailableUntil;
    return until === undefined ? soonest : Math.min(soonest ?? until, until);
  }, undefined);
}

export function modelPickerOptionKey(option: ChatModelPickerOption): string {
  return JSON.stringify([option.value, option.agentRuntime ?? null]);
}

export const FAVORITES_GROUP = "$favorites";
export const modelRowKey = (option: ChatModelPickerOption, provider: string) =>
  `${provider === FAVORITES_GROUP ? "favorite:" : ""}${modelPickerOptionKey(option)}`;

export function isModelPickerOptionSelected(
  option: ChatModelPickerOption,
  value: string,
  agentRuntime?: string,
): boolean {
  return (
    (option.value === value || (option.isDefault && value === "")) &&
    (option.agentRuntime === undefined || (option.agentRuntime ?? undefined) === agentRuntime)
  );
}

export function formatModelContextMeta(
  option: ChatModelPickerOption,
  translate: typeof t = t,
): string {
  const active = option.contextTokens;
  const maximum = option.contextWindow;
  if (active && maximum && active < maximum) {
    return translate("chat.modelControls.contextActiveAndMax", {
      active: formatContextTokenCapacity(active, 0),
      maximum: formatContextTokenCapacity(maximum, 0),
    });
  }
  const capacity = active || maximum;
  return capacity ? formatContextTokenCapacity(capacity, 0) : "";
}

/** Owners omit completed empty groups; a published group has rows or an active receipt. */
export type ChatModelPickerTargetGroup = {
  errorLabel: string;
  id: string;
  label: string;
  /** Accepted rows stay synchronous for search, shortcuts, and account offsets. */
  options: readonly { label: string; value: string }[];
  /** The box keys the boundary without unwrapping its promise outside Loading. */
  completion: { promise: Promise<ChatModelPickerTargetGroup["options"]> };
};

export function formatModelLabel(
  option: Pick<ChatModelPickerOption, "label" | "provider" | "presentation">,
): string {
  const prefixes = [
    formatRawProviderLabel(option.provider),
    providerDisplayLabel(option.provider, option.presentation),
  ].toSorted((left, right) => right.length - left.length);
  for (const prefix of prefixes) {
    if (option.label.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) {
      return option.label.slice(prefix.length + 1);
    }
    // Grouped rows already carry the provider as the section heading, so a
    // catalog name that repeats it as a trailing "(Provider)" reads twice.
    const suffix = ` (${prefix.toLowerCase()})`;
    if (option.label.toLowerCase().endsWith(suffix)) {
      return option.label.slice(0, option.label.length - suffix.length);
    }
  }
  return option.label;
}

export type ChatModelPickerOptionProps = {
  rowKey?: string;
  favorite?: { selected: boolean; disabled: boolean; onToggle: (event: MouseEvent) => void };
  contextWindow?: ChatContextWindowControlParams;
  hideCooldown?: boolean;
  sessionKey?: string;
  disabled: boolean;
  entry: ChatModelPickerOption;
  index: number;
  selectedModelValue: string;
  selectedAgentRuntime?: string;
  sessionModelPinned: boolean;
  onSelect: (entry: ChatModelPickerOption, event: MouseEvent) => void;
};

export type ChatModelPickerTargetOptionProps = {
  disabled: boolean;
  entry: ChatModelPickerTargetGroup["options"][number];
  groupId: string;
  groupLabel: string;
  index: number;
  onSelect: (groupId: string, value: string, event: MouseEvent) => void;
};

export const modelProviderId = (option: ChatModelPickerOption) =>
  option.provider === "claude-cli" ? "anthropic" : option.provider;

export function prepareChatModelPickerPanel(
  params: {
    modelOptions: ChatModelPickerOption[];
    selectedModelValue: string;
    selectedAgentRuntime?: string;
    targetGroups?: readonly ChatModelPickerTargetGroup[];
  },
  favorites?: { keys: readonly string[]; selected: string },
) {
  const defaultModelOption = params.modelOptions.find((option) => option.isDefault);
  const activeModelOption = params.modelOptions.find((option) =>
    isModelPickerOptionSelected(option, params.selectedModelValue, params.selectedAgentRuntime),
  );
  const leadingModelOption = activeModelOption ?? defaultModelOption;
  const groupProvider = modelProviderId;
  // Default restores inheritance; it stays ahead of ranked model choices. When a
  // provider recommends models, they follow, and the rest collapse under "All models".
  const recommendingProviders = new Set(
    params.modelOptions.filter((option) => option.recommended).map(groupProvider),
  );
  const providerGroups = new Map<
    string,
    { lead: ChatModelPickerOption[]; more: ChatModelPickerOption[] }
  >();
  for (const option of params.modelOptions) {
    const provider = groupProvider(option);
    const group = providerGroups.get(provider) ?? { lead: [], more: [] };
    if (option.isDefault) {
      group.lead.unshift(option);
    } else if (option === leadingModelOption) {
      group.lead.splice(group.lead[0]?.isDefault ? 1 : 0, 0, option);
    } else if (option.recommended || !recommendingProviders.has(provider)) {
      group.lead.push(option);
    } else {
      group.more.push(option);
    }
    providerGroups.set(provider, group);
  }
  // Unranked catalogs can contain hundreds of models; browse the rest through All models.
  for (const [provider, group] of providerGroups) {
    if (!recommendingProviders.has(provider)) {
      group.more = group.lead.splice(9);
    }
  }
  const byModel = new Map(
    params.modelOptions
      .filter((option) => !option.isDefault)
      .map((option) => [option.value, option]),
  );
  const favoriteOptions = (favorites?.keys ?? []).flatMap((key) => {
    const option = byModel.get(key);
    return option ? [option] : [];
  });
  for (const [provider, group] of providerGroups) {
    const first = [...group.lead, ...group.more].filter(
      (option) => option.isDefault || option.value === favorites?.selected,
    );
    const promoted = new Set([
      ...first,
      ...favoriteOptions.filter((option) => groupProvider(option) === provider),
    ]);
    group.lead = [...promoted, ...group.lead.filter((option) => !promoted.has(option))];
    group.more = group.more.filter((option) => !promoted.has(option));
  }
  const orderedProviderGroups = [...providerGroups];
  const leadingProvider = leadingModelOption && groupProvider(leadingModelOption);
  const activeProvider = activeModelOption && groupProvider(activeModelOption);

  if (favoriteOptions.length && orderedProviderGroups.length > 1) {
    orderedProviderGroups.unshift([FAVORITES_GROUP, { lead: favoriteOptions, more: [] }]);
  }
  const orderedOptions = orderedProviderGroups.flatMap(([, { lead, more }]) => [...lead, ...more]);
  const optionIndex = new Map(
    orderedProviderGroups
      .flatMap(([provider, group]) =>
        [...group.lead, ...group.more].map((option) => modelRowKey(option, provider)),
      )
      .map((key, index) => [key, index]),
  );
  const targetGroups = params.targetGroups ?? [];
  const targetOptionCount = targetGroups.reduce((count, group) => count + group.options.length, 0);
  const hasOptions = params.modelOptions.length > 0 || targetGroups.length > 0;
  const hasSelectableModelOptions = params.modelOptions.some((option) => !option.disabled);
  return {
    orderedProviderGroups,
    activeProvider: activeProvider ?? leadingProvider ?? orderedProviderGroups[0]?.[0],
    orderedOptions,
    optionIndex,
    targetGroups,
    targetOptionCount,
    hasOptions,
    hasSelectableModelOptions,
  };
}
