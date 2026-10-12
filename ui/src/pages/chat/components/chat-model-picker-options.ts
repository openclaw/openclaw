import { formatRawProviderLabel, providerDisplayLabel } from "../../../components/provider-icon.ts";
import { t } from "../../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import { formatContextTokenCapacity } from "../../../lib/format.ts";
import type { ModelRuntimeEntry } from "../../../lib/model-runtime-choice.ts";

registerModelControlsEnglish();

export type ChatModelPickerOption = {
  agentRuntimeId?: string;
  /** Null is an unknown configured base; undefined is an ordinary model-only row. Both clear a prior pin. */
  agentRuntime?: string | null;
  /** Only explicit alternatives pin a runtime; configured base rows follow current routing. */
  runtimeOverride?: string;
  commitValue: string;
  contextTokens?: number;
  contextWindow?: number;
  disabled?: boolean;
  unavailableReason?: ModelRuntimeEntry["unavailableReason"];
  isDefault: boolean;
  label: string;
  provider: string;
  /** Hosted-catalog recommendation; the rest of its provider collapses under "All models". */
  recommended?: boolean;
  supportsTools?: boolean;
  value: string;
};

export function modelPickerOptionKey(option: ChatModelPickerOption): string {
  return JSON.stringify([option.value, option.agentRuntime ?? null]);
}

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

export function formatModelContextMeta(option: ChatModelPickerOption): string {
  const active = option.contextTokens;
  const maximum = option.contextWindow;
  if (active && maximum && active !== maximum) {
    return t("chat.modelControls.contextActiveAndMax", {
      active: formatContextTokenCapacity(active),
      maximum: formatContextTokenCapacity(maximum),
    });
  }
  return maximum ? formatContextTokenCapacity(maximum) : "";
}

export type ChatModelPickerTargetGroup = {
  errorLabel: string;
  id: string;
  label: string;
  options: readonly { label: string; value: string }[];
  status: "loading" | "ready" | "error";
};

export function formatModelLabel(option: ChatModelPickerOption): string {
  const prefixes = [
    formatRawProviderLabel(option.provider),
    providerDisplayLabel(option.provider),
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
  disabled: boolean;
  entry: ChatModelPickerOption;
  index: number;
  selectedModelValue: string;
  selectedAgentRuntime?: string;
  sessionModelPinned: boolean;
  onSelect: (entry: ChatModelPickerOption, event: MouseEvent) => void;
  onModelSetup?: () => void;
};

export type ChatModelPickerTargetOptionProps = {
  disabled: boolean;
  entry: ChatModelPickerTargetGroup["options"][number];
  groupId: string;
  groupLabel: string;
  index: number;
  onSelect: (groupId: string, value: string, event: MouseEvent) => void;
};
