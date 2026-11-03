import { createMemo, For } from "solid-js";
import { formatModelRuntimeLabel } from "../../../lib/model-runtime-label.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { ChatContextWindowControl } from "./chat-context-window-control.tsx";
import type { ChatModelAccountSection } from "./chat-model-account-control.ts";
import { ChatModelAccountSectionView } from "./chat-model-account-control.tsx";
import type { ChatModelPickerOption } from "./chat-model-picker-options.ts";
import type { ChatModelPickerParams } from "./chat-model-picker.tsx";

export const modelRuntimeId = (option: ChatModelPickerOption) =>
  option.agentRuntimeId ??
  option.agentRuntime ??
  (option.provider === "claude-cli" ? "claude-cli" : "openclaw");
export const modelProviderId = (option: ChatModelPickerOption) =>
  option.provider === "claude-cli" ? "anthropic" : option.provider;

export function providerRuntimeOptions(
  options: ChatModelPickerOption[],
  selected: string,
): ChatModelPickerOption[] {
  const models = Map.groupBy(options, (option) => option.value);
  return [...models.values()].map(
    (choices) => choices.find((option) => modelRuntimeId(option) === selected) ?? choices[0]!,
  );
}

export function ChatModelRuntimeControl(props: {
  options: ChatModelPickerOption[];
  model: string;
  selected: string;
  disabled: boolean;
  onSelect: (runtime: string, option: ChatModelPickerOption | undefined) => void;
}) {
  const runtimes = createMemo(() => [...new Set(props.options.map(modelRuntimeId))]);
  const option = (runtime: string) =>
    props.options.find(
      (entry) =>
        (entry.value === props.model || (entry.isDefault && !props.model)) &&
        modelRuntimeId(entry) === runtime,
    );
  const blocked = (runtime: string) => {
    const entry = option(runtime);
    return (
      !entry ||
      Boolean(
        entry.disabled &&
        entry.unavailableReason !== "missing-auth" &&
        entry.unavailableReason !== "auth-failed",
      )
    );
  };
  return (
    <div class="chat-controls__runtime-row">
      <span class="chat-controls__settings-label">{t("chat.modelControls.runsOn")}</span>
      <div
        class="settings-segmented settings-segmented--compact"
        role="group"
        aria-label={t("chat.modelControls.runsOn")}
      >
        <For each={runtimes()}>
          {(runtime) => (
            <openclaw-tooltip
              prop:content={
                blocked(runtime)
                  ? t("chat.modelControls.runtimeUnavailable")
                  : (formatModelRuntimeLabel(props.options[0]?.provider ?? "", runtime, t)
                      ?.detail ?? "")
              }
            >
              <button
                type="button"
                class={[
                  "settings-segmented__btn",
                  { "settings-segmented__btn--active": props.selected === runtime },
                ]}
                data-chat-model-runtime={runtime}
                aria-pressed={props.selected === runtime ? "true" : "false"}
                aria-disabled={props.disabled || blocked(runtime) ? "true" : "false"}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!props.disabled && !blocked(runtime)) {
                    props.onSelect(runtime, option(runtime));
                  }
                }}
              >
                {formatModelRuntimeLabel(props.options[0]?.provider ?? "", runtime, t)?.label}
              </button>
            </openclaw-tooltip>
          )}
        </For>
      </div>
    </div>
  );
}

export function ChatModelSettings(props: {
  params: ChatModelPickerParams;
  account: ReturnType<ChatModelAccountSection["viewProps"]> | undefined;
  providers: Map<string, ChatModelPickerOption[]>;
  provider: string | undefined;
  runtime: (provider: string) => string;
  onRuntimeSelect: (
    provider: string,
    runtime: string,
    option: ChatModelPickerOption | undefined,
  ) => void;
}) {
  const options = createMemo(() => props.providers.get(props.provider ?? "") ?? []);
  return (
    <div class="chat-controls__model-settings-block">
      {new Set(options().map(modelRuntimeId)).size > 1 ? (
        <ChatModelRuntimeControl
          options={options()}
          model={
            options().some(
              (option) =>
                option.value === props.params.selectedModelValue ||
                (option.isDefault && !props.params.selectedModelValue),
            )
              ? props.params.selectedModelValue
              : options()[0]!.value
          }
          selected={props.runtime(props.provider!)}
          disabled={props.params.disabled}
          onSelect={(runtime, option) => props.onRuntimeSelect(props.provider!, runtime, option)}
        />
      ) : undefined}
      {props.params.contextWindow ? (
        <ChatContextWindowControl
          contextWindow={props.params.contextWindow}
          sessionKey={props.params.sessionKey}
        />
      ) : undefined}
      {props.account ? <ChatModelAccountSectionView {...props.account} /> : undefined}
    </div>
  );
}
