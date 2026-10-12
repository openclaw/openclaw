import { createMemo, Show } from "solid-js";
import { providerDisplayLabel } from "../../../components/provider-icon.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { Kbd } from "../../../components/solid/kbd.tsx";
import { ProviderBrandIcon } from "../../../components/solid/provider-icon.tsx";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { formatModelRuntimeLabel } from "../../../lib/model-runtime-label.ts";
import {
  formatModelContextMeta,
  formatModelLabel,
  isModelPickerOptionSelected,
  type ChatModelPickerOptionProps,
  type ChatModelPickerTargetOptionProps,
} from "./chat-model-picker-options.ts";
import { handleModelOptionMouseEnter } from "./chat-model-picker-search.ts";

function ModelShortcut() {
  return (
    <Kbd
      keys=""
      ariaHidden
      hidden
      ref={(element) => element.setAttribute("data-chat-model-shortcut", "true")}
    />
  );
}

export function ChatModelProviderIcon(props: { provider: string }) {
  return <ProviderBrandIcon provider={props.provider} class="chat-controls__provider-icon" />;
}

function createOptionPresentation(props: ChatModelPickerOptionProps) {
  return createMemo(() => {
    const selected = isModelPickerOptionSelected(
      props.entry,
      props.selectedModelValue,
      props.selectedAgentRuntime,
    );
    const modelLabel = formatModelLabel(props.entry);
    const runtime = formatModelRuntimeLabel(props.entry.provider, props.entry.agentRuntimeId);
    const runtimeLabel = runtime?.label ?? "";
    const routeDetail = runtime?.detail ?? "";
    const chatOnlyHelp =
      props.entry.supportsTools === false ? t("chat.modelControls.chatOnlyHelp") : "";
    const detail = [routeDetail, chatOnlyHelp].filter(Boolean).join(" ");
    // Resetting a recorded pin remains possible even when its default model is unavailable.
    const resetsPin = props.entry.isDefault && props.sessionModelPinned;
    const needsAuth =
      props.entry.disabled &&
      (props.entry.unavailableReason === "missing-auth" ||
        props.entry.unavailableReason === "auth-failed");
    const onModelSetup = needsAuth ? props.onModelSetup : undefined;
    const modelMeta = needsAuth
      ? runtime?.detail !== undefined
        ? runtimeLabel
        : ""
      : [formatModelContextMeta(props.entry), runtimeLabel].filter(Boolean).join(" · ");
    const accessibleStatus = needsAuth
      ? t("modelSetup.candidates.signInNeeded")
      : props.entry.unavailableReason === "unsupported-runtime"
        ? t("chat.modelControls.runtimeUnavailable")
        : "";
    return {
      selected,
      modelLabel,
      runtimeLabel,
      chatOnlyHelp,
      detail,
      resetsPin,
      needsAuth,
      onModelSetup,
      modelMeta,
      accessibleStatus,
    };
  });
}

type OptionPresentation = ReturnType<ReturnType<typeof createOptionPresentation>>;

function ModelOptionButton(
  props: ChatModelPickerOptionProps & { presentation: OptionPresentation },
) {
  return (
    <button
      class={[
        "chat-controls__inline-select-option chat-controls__model-option",
        {
          "chat-controls__inline-select-option--selected": props.presentation.selected,
        },
      ]}
      data-chat-model-option={props.entry.value}
      data-chat-model-runtime={props.entry.agentRuntime ?? undefined}
      data-chat-model-default={props.entry.isDefault ? "true" : undefined}
      data-chat-model-index={props.index}
      data-chat-model-keywords={[
        props.entry.isDefault ? t("chat.modelControls.default") : "",
        props.presentation.runtimeLabel,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()}
      data-chat-model-name={props.presentation.modelLabel.toLocaleLowerCase()}
      data-chat-model-provider-label={providerDisplayLabel(
        props.entry.provider,
      ).toLocaleLowerCase()}
      role="option"
      hidden
      aria-selected={props.presentation.selected ? "true" : "false"}
      title={props.presentation.accessibleStatus || undefined}
      aria-label={[
        props.presentation.modelLabel,
        props.presentation.runtimeLabel,
        props.presentation.accessibleStatus,
        props.presentation.chatOnlyHelp,
      ]
        .filter(Boolean)
        .join(". ")}
      type="button"
      disabled={
        props.disabled ||
        Boolean(
          props.entry.disabled && !props.presentation.onModelSetup && !props.presentation.resetsPin,
        )
      }
      data-chat-model-setup={props.presentation.onModelSetup ? "true" : undefined}
      onMouseEnter={handleModelOptionMouseEnter}
      onClick={(event) => {
        // Auth-gated rows lead to setup rather than trapping a click on a disabled model.
        if (props.entry.disabled && !props.presentation.resetsPin) {
          event.stopPropagation();
          props.presentation.onModelSetup?.();
          return;
        }
        props.onSelect(props.entry, event);
      }}
    >
      <span class="chat-controls__model-option-provider">
        <ChatModelProviderIcon provider={props.entry.provider} />
      </span>
      <span class="chat-controls__model-option-copy">
        <span class="chat-controls__model-option-title">
          <span class="chat-controls__model-option-name">{props.presentation.modelLabel}</span>
          <Show when={props.entry.isDefault}>
            <span class="chat-controls__model-state-label chat-controls__model-state-label--default">
              {t("chat.modelControls.default")}
            </span>
          </Show>
          <Show when={props.presentation.modelMeta}>
            <span class="chat-controls__model-option-meta">{props.presentation.modelMeta}</span>
          </Show>
          <Show when={props.presentation.needsAuth}>
            <span class="chat-controls__model-option-auth-warning" data-chat-model-auth-warning>
              <Icon name="alertTriangle" />
              <span>{props.presentation.accessibleStatus}</span>
            </span>
          </Show>
          <Show when={props.entry.supportsTools === false}>
            <span class="chat-controls__model-chat-only-info" aria-hidden="true">
              <Icon name="info" />
            </span>
          </Show>
        </span>
      </span>
      <span class="chat-controls__model-option-action">
        <Show when={props.presentation.selected} fallback={<ModelShortcut />}>
          <span class="chat-controls__inline-select-check" aria-hidden="true">
            <Icon name="check" />
          </span>
        </Show>
      </span>
    </button>
  );
}

export function ChatModelPickerOption(props: ChatModelPickerOptionProps) {
  const presentation = createOptionPresentation(props);
  return (
    <Show
      when={presentation().detail}
      fallback={<ModelOptionButton {...props} presentation={presentation()} />}
    >
      <openclaw-tooltip prop:content={presentation().detail}>
        <ModelOptionButton {...props} presentation={presentation()} />
      </openclaw-tooltip>
    </Show>
  );
}

export function ChatModelPickerTargetOption(props: ChatModelPickerTargetOptionProps) {
  return (
    <button
      class="chat-controls__inline-select-option chat-controls__model-option"
      data-chat-model-option={`target:${props.groupId}:${props.entry.value}`}
      data-chat-model-target={props.entry.value}
      data-chat-model-index={props.index}
      data-chat-model-name={props.entry.label.toLocaleLowerCase()}
      data-chat-model-provider-label={props.groupLabel.toLocaleLowerCase()}
      role="option"
      aria-selected="false"
      type="button"
      disabled={props.disabled}
      onMouseEnter={handleModelOptionMouseEnter}
      onClick={(event) => props.onSelect(props.groupId, props.entry.value, event)}
    >
      <span
        class="chat-controls__model-option-provider chat-controls__target-icon"
        aria-hidden="true"
      >
        <Icon name="terminal" />
      </span>
      <span class="chat-controls__model-option-copy">
        <span class="chat-controls__model-option-title">
          <span class="chat-controls__model-option-name">{props.entry.label}</span>
        </span>
      </span>
      <span class="chat-controls__model-option-action">
        <ModelShortcut />
      </span>
    </button>
  );
}
