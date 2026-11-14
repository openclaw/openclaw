import { createMemo, createUniqueId, For, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Popover, type PopoverHandle } from "../../../components/solid/popover.tsx";
import { formatModelRuntimeLabel } from "../../../lib/model-runtime-label.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatModelPickerOption } from "./chat-model-picker-options.ts";
import type { ChatModelPickerParams } from "./chat-model-picker.tsx";

export const modelRuntimeId = (option: ChatModelPickerOption) =>
  option.agentRuntimeId ??
  (option.agentRuntime === null
    ? null
    : (option.agentRuntime ?? (option.provider === "claude-cli" ? "claude-cli" : "openclaw")));

export function providerRuntimeOptions(
  options: ChatModelPickerOption[],
  selected: string | null,
): ChatModelPickerOption[] {
  const models = Map.groupBy(options, (option) => option.value);
  return [...models.values()].map(
    (choices) => choices.find((option) => modelRuntimeId(option) === selected) ?? choices[0]!,
  );
}

export function ChatModelRuntimeControl(props: {
  options: ChatModelPickerOption[];
  model: string;
  selected: string | null;
  disabled: boolean;
  onSelect: (runtime: string | null, option: ChatModelPickerOption | undefined) => void;
}) {
  const infoId = createUniqueId();
  let info: PopoverHandle | undefined;
  const runtimes = createMemo(() => [...new Set(props.options.map(modelRuntimeId))]);
  const presentation = (runtime: string | null) =>
    runtime === null
      ? { label: t("chat.modelControls.default"), detail: undefined }
      : formatModelRuntimeLabel(props.options[0]?.provider ?? "", runtime, t);
  const option = (runtime: string | null) =>
    props.options.find(
      (entry) =>
        (entry.value === props.model || (entry.isDefault && !props.model)) &&
        modelRuntimeId(entry) === runtime,
    );
  const blocked = (runtime: string | null) => {
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
      <span class="chat-controls__settings-label">
        {t("chat.modelControls.runsOn")}
        <Show when={runtimes().length > 1}>
          <Popover
            ref={(handle) => (info = handle)}
            id={infoId}
            label={t("chat.modelControls.runsOn")}
            triggerClass="chat-controls__runtime-info"
            class="chat-controls__settings-popover chat-controls__runtime-details"
            placement="top-start"
            sameRoot
            trigger={<Icon name="info" />}
          >
            <div class="chat-controls__runtime-details-content">
              <div class="chat-controls__runtime-details-header">
                <span>{t("chat.modelControls.runsOn")}</span>
                <button
                  class="chat-controls__runtime-details-close"
                  type="button"
                  aria-label={t("common.close")}
                  onClick={() => info?.hide()}
                >
                  <Icon name="x" />
                </button>
              </div>
              <For each={runtimes()}>
                {(runtime) => (
                  <div>
                    <div class="chat-controls__runtime-detail-label">
                      {presentation(runtime)?.label}
                    </div>
                    <div class="chat-controls__runtime-detail-copy">
                      {runtime === null
                        ? undefined
                        : (presentation(runtime)?.detail ??
                          t("chat.modelControls.completionRoutes.harness.detail", {
                            runtime: presentation(runtime)?.label ?? "",
                          }))}
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Popover>
        </Show>
      </span>
      <div
        class="chat-controls__runtime-segments"
        role="group"
        aria-label={t("chat.modelControls.runsOn")}
      >
        <For each={runtimes()}>
          {(runtime) => (
            <openclaw-tooltip
              prop:content={
                blocked(runtime)
                  ? t("chat.modelControls.runtimeUnavailable")
                  : (presentation(runtime)?.detail ?? "")
              }
            >
              <button
                type="button"
                class={[
                  "chat-controls__runtime-option",
                  { "chat-controls__runtime-option--active": props.selected === runtime },
                ]}
                data-chat-model-runtime={runtime ?? ""}
                aria-pressed={props.selected === runtime ? "true" : "false"}
                aria-disabled={props.disabled || blocked(runtime) ? "true" : "false"}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!props.disabled && !blocked(runtime)) {
                    props.onSelect(runtime, option(runtime));
                  }
                }}
              >
                {presentation(runtime)?.label}
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
  providers: Map<string, ChatModelPickerOption[]>;
  provider: string | undefined;
  runtime: (provider: string) => string | null;
  onRuntimeSelect: (
    provider: string,
    runtime: string | null,
    option: ChatModelPickerOption | undefined,
  ) => void;
}) {
  const options = createMemo(() => props.providers.get(props.provider ?? "") ?? []);
  return (
    <>
      {new Set(options().map(modelRuntimeId)).size > 1 ? (
        <ChatModelRuntimeControl
          options={options()}
          model={
            options().find(
              (option) =>
                option.value === props.params.selectedModelValue ||
                (option.isDefault && !props.params.selectedModelValue),
            )?.value ?? options()[0]!.value
          }
          selected={props.runtime(props.provider!)}
          disabled={props.params.disabled}
          onSelect={(runtime, option) => props.onRuntimeSelect(props.provider!, runtime, option)}
        />
      ) : undefined}
    </>
  );
}
