import { createMemo, Show, useContext } from "solid-js";
import { providerDisplayLabel } from "../../../components/provider-icon-data.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { ProviderBrandIcon } from "../../../components/solid/provider-icon.tsx";
import "../../../components/tooltip.ts";
import { formatModelRuntimeLabel } from "../../../lib/model-runtime-label.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  formatModelContextMeta,
  formatModelLabel,
  isModelPickerOptionSelected,
  modelPickerOptionKey,
  type ChatModelPickerOptionProps,
  type ChatModelPickerTargetOptionProps,
} from "./chat-model-picker-options.ts";
import {
  ChatModelSearchContext,
  handleModelOptionMouseEnter,
  type ChatModelSearchRow,
} from "./chat-model-picker-search.ts";

function ModelShortcut(props: { rowKey: string }) {
  const search = useContext(ChatModelSearchContext);
  const number = createMemo(() => search?.row(props.rowKey)?.shortcut);
  return (
    <kbd
      class="shortcut-kbd"
      aria-hidden="true"
      hidden={number() === undefined}
      data-chat-model-shortcut="true"
      data-shortcut={number()}
      data-chat-model-shortcut-number={number()}
    />
  );
}

export function ChatModelProviderIcon(props: { provider: string }) {
  return <ProviderBrandIcon provider={props.provider} class="chat-controls__provider-icon" />;
}

type ModelPresentationProps = Omit<ChatModelPickerOptionProps, "onSelect" | "index">;

function optionPresentation(options: ModelPresentationProps) {
  const selected = isModelPickerOptionSelected(
    options.entry,
    options.selectedModelValue,
    options.selectedAgentRuntime,
  );
  const modelLabel = formatModelLabel(options.entry);
  const runtime = formatModelRuntimeLabel(options.entry.provider, options.entry.agentRuntimeId);
  const runtimeLabel = runtime?.label ?? "";
  const routeDetail = runtime?.detail ?? "";
  const chatOnlyHelp =
    options.entry.supportsTools === false ? t("chat.modelControls.chatOnlyHelp") : "";
  const detail = [routeDetail, chatOnlyHelp].filter(Boolean).join(" ");
  // Resetting a recorded pin remains possible even when its default model is unavailable.
  const resetsPin = options.entry.isDefault && options.sessionModelPinned;
  const needsAuth =
    options.entry.disabled &&
    (options.entry.unavailableReason === "missing-auth" ||
      options.entry.unavailableReason === "auth-failed");
  const onModelSetup = needsAuth ? options.onModelSetup : undefined;
  const modelMeta = needsAuth
    ? runtime?.detail !== undefined
      ? runtimeLabel
      : ""
    : [formatModelContextMeta(options.entry), runtimeLabel].filter(Boolean).join(" · ");
  const accessibleStatus = needsAuth
    ? t("modelSetup.candidates.signInNeeded")
    : options.entry.unavailableReason === "unsupported-runtime"
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
}

function createOptionPresentation(props: ChatModelPickerOptionProps) {
  return createMemo(() => optionPresentation(props));
}

export function modelOptionSearchRow(options: ModelPresentationProps): ChatModelSearchRow {
  const view = optionPresentation(options);
  return {
    key: modelPickerOptionKey(options.entry),
    name: view.modelLabel.toLocaleLowerCase(),
    keywords: [options.entry.isDefault ? t("chat.modelControls.default") : "", view.runtimeLabel]
      .join(" ")
      .toLocaleLowerCase(),
    providerLabel: providerDisplayLabel(options.entry.provider).toLocaleLowerCase(),
    reference: options.entry.value,
    selected: view.selected,
    hasShortcut: !view.selected,
    disabled:
      options.disabled || Boolean(options.entry.disabled && !view.onModelSetup && !view.resetsPin),
  };
}

type OptionPresentation = ReturnType<ReturnType<typeof createOptionPresentation>>;

function ModelOptionButton(
  props: ChatModelPickerOptionProps & { presentation: OptionPresentation },
) {
  const search = useContext(ChatModelSearchContext);
  const key = createMemo(() => modelPickerOptionKey(props.entry));
  // Query changes should reach only rows whose displayed search facts changed.
  const rank = createMemo(() => search?.row(key())?.rank);
  const hidden = createMemo(() => search?.row(key())?.hidden ?? false);
  const highlighted = createMemo(() => search?.highlighted() === key());
  return (
    <button
      ref={search?.rowRef(key)}
      id={search?.optionId(key())}
      class={[
        "chat-controls__inline-select-option chat-controls__model-option",
        {
          "chat-controls__inline-select-option--selected": props.presentation.selected,
        },
      ]}
      data-chat-model-option={props.entry.value}
      data-chat-model-key={key()}
      data-chat-model-rank={rank()}
      data-chat-model-highlighted={highlighted() ? "" : undefined}
      style={{ "--chat-model-rank": rank() }}
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
      aria-posinset={search?.row(key())?.position}
      aria-setsize={search?.row(key())?.size}
      hidden={hidden()}
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
        <Show when={props.presentation.selected} fallback={<ModelShortcut rowKey={key()} />}>
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
  const search = useContext(ChatModelSearchContext);
  const key = createMemo(() => `target:${props.groupId}:${props.entry.value}`);
  const rank = createMemo(() => search?.row(key())?.rank);
  const hidden = createMemo(() => search?.row(key())?.hidden ?? false);
  const highlighted = createMemo(() => search?.highlighted() === key());
  return (
    <button
      ref={search?.rowRef(key)}
      id={search?.optionId(key())}
      hidden={hidden()}
      data-chat-model-key={key()}
      data-chat-model-rank={rank()}
      data-chat-model-highlighted={highlighted() ? "" : undefined}
      style={{ "--chat-model-rank": rank() }}
      class="chat-controls__inline-select-option chat-controls__model-option"
      data-chat-model-option={`target:${props.groupId}:${props.entry.value}`}
      data-chat-model-target={props.entry.value}
      data-chat-model-index={props.index}
      data-chat-model-name={props.entry.label.toLocaleLowerCase()}
      data-chat-model-provider-label={props.groupLabel.toLocaleLowerCase()}
      role="option"
      aria-posinset={search?.row(key())?.position}
      aria-setsize={search?.row(key())?.size}
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
        <ModelShortcut rowKey={key()} />
      </span>
    </button>
  );
}
