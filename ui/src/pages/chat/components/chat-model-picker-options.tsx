import { createMemo, Show, useContext } from "solid-js";
import { providerDisplayLabel } from "../../../components/provider-icon-data.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { ProviderBrandIcon } from "../../../components/solid/provider-icon.tsx";
import { formatDurationHuman } from "../../../lib/format-duration.ts";
import { formatModelRuntimeLabel } from "../../../lib/model-runtime-label.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { keyboardHintsVisible } from "../../../lib/reactive/keyboard-hints.ts";
import "../../../components/tooltip.ts";
import { readVisibleTime } from "../../../lib/reactive/visible-clock.ts";
import {
  formatModelContextMeta,
  formatModelLabel,
  isModelPickerOptionSelected,
  modelPickerOptionKey,
  type ChatModelPickerOptionProps,
  type ChatModelPickerTargetOptionProps,
} from "./chat-model-picker-options.ts";
import { ChatModelSearchContext, type ChatModelSearchRow } from "./chat-model-picker-search.ts";

function ModelCooldown(props: { until: number }) {
  const search = useContext(ChatModelSearchContext);
  const label = createMemo(() => {
    const remaining =
      props.until - (search?.open() !== false ? readVisibleTime(30_000) : Date.now());
    // The Gateway still owns availability after the deadline; only retire the countdown.
    return remaining > 0
      ? t("chat.modelControls.cooldown", {
          time: formatDurationHuman(Math.ceil(remaining / 60_000) * 60_000),
        })
      : undefined;
  });
  return (
    <Show when={label()}>
      {(text) => <span class="chat-controls__model-cooldown">{text()}</span>}
    </Show>
  );
}

function ModelShortcut(props: { rowKey: string }) {
  const search = useContext(ChatModelSearchContext);
  const number = createMemo(() => search?.row(props.rowKey)?.shortcut);
  return (
    <kbd
      class="shortcut-kbd"
      aria-hidden="true"
      hidden={number() === undefined || !keyboardHintsVisible()}
      data-chat-model-shortcut="true"
      data-shortcut={number()}
      data-chat-model-shortcut-number={number()}
    />
  );
}

export function ChatModelProviderIcon(props: { provider: string }) {
  return <ProviderBrandIcon provider={props.provider} class="chat-controls__provider-icon" />;
}

export function ChatModelTargetIcon() {
  return (
    <span
      class="chat-controls__provider-icon provider-brand-icon provider-brand-icon--fallback"
      aria-hidden="true"
    >
      ›
    </span>
  );
}

type ModelPresentationProps = Omit<ChatModelPickerOptionProps, "onSelect" | "index">;

function optionBlocksSelection(entry: ModelPresentationProps["entry"]) {
  return (
    entry.disabled &&
    (entry.unavailableReason === "missing-auth" ||
      entry.unavailableReason === "auth-failed" ||
      entry.unavailableReason === "cooldown")
  );
}

function optionPresentation(options: ModelPresentationProps) {
  const selected = isModelPickerOptionSelected(
    options.entry,
    options.selectedModelValue,
    options.selectedAgentRuntime,
  );
  const modelLabel = formatModelLabel(options.entry);
  const runtime = formatModelRuntimeLabel(options.entry.provider, options.entry.agentRuntimeId, t);
  const runtimeLabel = runtime?.label ?? "";
  const routeDetail = runtime?.detail ?? "";
  const chatOnlyHelp =
    options.entry.supportsTools === false ? t("chat.modelControls.chatOnlyHelp") : "";
  const detail = [routeDetail, chatOnlyHelp].filter(Boolean).join(" ");
  // A missing default may still reset a recorded pin; auth and cooldown blocks stay inert.
  const resetsPin = options.entry.isDefault && options.sessionModelPinned;
  const blocked = optionBlocksSelection(options.entry);
  const coolingDown = blocked && options.entry.unavailableReason === "cooldown";
  const needsAuth = blocked && !coolingDown;
  const cooldownUntil = coolingDown ? options.entry.unavailableUntil : undefined;
  const modelMeta = blocked ? "" : formatModelContextMeta(options.entry, t);
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
    blocked,
    coolingDown,
    cooldownUntil,
    modelMeta,
    accessibleStatus,
  };
}

function createOptionPresentation(props: ChatModelPickerOptionProps) {
  return createMemo(() => optionPresentation(props));
}

export function modelOptionSearchRow(
  options: ModelPresentationProps,
  defaultLabel: string,
): ChatModelSearchRow {
  const selected = isModelPickerOptionSelected(
    options.entry,
    options.selectedModelValue,
    options.selectedAgentRuntime,
  );
  const runtimeLabel =
    formatModelRuntimeLabel(options.entry.provider, options.entry.agentRuntimeId)?.label ?? "";
  const resetsPin = options.entry.isDefault && options.sessionModelPinned;
  return {
    key: modelPickerOptionKey(options.entry),
    name: formatModelLabel(options.entry).toLocaleLowerCase(),
    keywords: [options.entry.isDefault ? defaultLabel : "", runtimeLabel]
      .join(" ")
      .toLocaleLowerCase(),
    providerLabel: providerDisplayLabel(options.entry.provider).toLocaleLowerCase(),
    reference: options.entry.value,
    selected,
    hasShortcut: !selected,
    disabled:
      options.disabled ||
      optionBlocksSelection(options.entry) ||
      Boolean(options.entry.disabled && !resetsPin),
  };
}

type OptionPresentation = ReturnType<ReturnType<typeof createOptionPresentation>>;

function ModelOptionButton(
  props: ChatModelPickerOptionProps & { presentation: OptionPresentation },
) {
  const search = useContext(ChatModelSearchContext);
  const defaultLabel = createMemo(() =>
    props.entry.isDefault ? t("chat.modelControls.default") : "",
  );
  const key = createMemo(() => modelPickerOptionKey(props.entry));
  // Query changes should reach only rows whose displayed search facts changed.
  const rank = createMemo(() => search?.row(key())?.rank);
  const hidden = createMemo(() => search?.row(key())?.hidden ?? false);
  const highlighted = createMemo(() => search?.isHighlighted(key()));
  return (
    <button
      ref={search?.rowRef(key)}
      id={search?.optionId(key())}
      class={[
        "chat-controls__inline-select-option chat-controls__model-option",
        {
          "chat-controls__inline-select-option--selected":
            props.presentation.selected && !props.presentation.blocked,
        },
      ]}
      data-chat-model-option={props.entry.value}
      data-chat-model-key={key()}
      data-chat-model-rank={rank()}
      data-chat-model-highlighted={highlighted() && !props.presentation.blocked ? "" : undefined}
      style={{ "--chat-model-rank": rank() }}
      data-chat-model-runtime={props.entry.agentRuntime ?? undefined}
      data-chat-model-default={props.entry.isDefault ? "true" : undefined}
      data-chat-model-index={props.index}
      data-chat-model-keywords={[defaultLabel(), props.presentation.runtimeLabel]
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
        props.presentation.blocked ||
        Boolean(props.entry.disabled && !props.presentation.resetsPin)
      }
      data-chat-model-auth-blocked={props.presentation.needsAuth ? "" : undefined}
      data-chat-model-cooldown={props.presentation.coolingDown ? "" : undefined}
      onClick={(event) => {
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
              {defaultLabel()}
            </span>
          </Show>
          <Show when={props.entry.supportsTools === false}>
            <span class="chat-controls__model-chat-only-info" aria-hidden="true">
              <Icon name="info" />
            </span>
          </Show>
          <Show when={props.presentation.modelMeta || props.presentation.cooldownUntil}>
            <span class="chat-controls__model-option-meta">
              <Show when={props.presentation.cooldownUntil} fallback={props.presentation.modelMeta}>
                {(until) => <ModelCooldown until={until()} />}
              </Show>
            </span>
          </Show>
        </span>
      </span>
      <span class="chat-controls__model-option-action">
        <Show when={!props.presentation.blocked}>
          <Show when={props.presentation.selected} fallback={<ModelShortcut rowKey={key()} />}>
            <span class="chat-controls__inline-select-check" aria-hidden="true">
              <Icon name="check" />
            </span>
          </Show>
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
  const highlighted = createMemo(() => search?.isHighlighted(key()));
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
      onClick={(event) => props.onSelect(props.groupId, props.entry.value, event)}
    >
      <span
        class="chat-controls__model-option-provider chat-controls__target-icon"
        aria-hidden="true"
      >
        <ChatModelTargetIcon />
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
