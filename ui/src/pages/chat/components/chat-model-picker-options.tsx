import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Errored, For, Loading, Show, useContext } from "solid-js";
import { providerDisplayLabel as defaultProviderLabel } from "../../../components/provider-icon-data.ts";
import type { ProviderPresentation } from "../../../components/provider-icon-data.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { ProviderBrandIcon } from "../../../components/solid/provider-icon.tsx";
import { Tooltip } from "../../../components/solid/tooltip.tsx";
import { registerModelFavoritesEnglish } from "../../../i18n/locales/en-model-favorites.ts";
import { formatDurationHuman } from "../../../lib/format-duration.ts";
import "../../../components/tooltip.ts";
import { formatModelRuntimeLabel } from "../../../lib/model-runtime-label.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { keyboardHintsVisible } from "../../../lib/reactive/keyboard-hints.ts";
import { createMediaQuery } from "../../../lib/reactive/platform.ts";
import { readVisibleTime } from "../../../lib/reactive/visible-clock.ts";
import { ChatContextWindowControl } from "./chat-context-window-control.tsx";
import { ChatModelCatalogState } from "./chat-model-catalog-state.tsx";
import {
  formatModelContextMeta,
  formatModelLabel,
  isModelPickerOptionSelected,
  modelPickerOptionKey,
  type ChatModelPickerOptionProps,
  type ChatModelPickerTargetOptionProps,
  type ChatModelPickerTargetGroup,
} from "./chat-model-picker-options.ts";
import { ChatModelSearchContext, type ChatModelSearchRow } from "./chat-model-picker-search.ts";
import type { createModelPickerWindow } from "./chat-model-picker-window.tsx";
import type { ChatModelPickerParams } from "./chat-model-picker.tsx";

export function ModelList(props: {
  label: string;
  id: string;
  more?: boolean;
  children: JSX.Element;
}) {
  const search = useContext(ChatModelSearchContext);
  return (
    <div
      id={search?.listId(props.id)}
      class="chat-controls__provider-model-list"
      data-chat-model-list="true"
      data-chat-model-more={props.more ? "" : undefined}
      role="listbox"
      aria-label={props.label}
    >
      {props.children}
    </div>
  );
}

export function ChatModelCooldown(props: { until: number }) {
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

registerEnglishCatalog(registerModelFavoritesEnglish);

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

export function ChatModelProviderIcon(props: {
  provider: string;
  presentation?: ProviderPresentation;
}) {
  return (
    <ProviderBrandIcon
      provider={props.provider}
      presentation={props.presentation}
      class="chat-controls__provider-icon"
    />
  );
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
  const cooldownUntil =
    coolingDown && !options.hideCooldown ? options.entry.unavailableUntil : undefined;
  const context =
    selected && !coolingDown && (options.contextWindow?.options.length ?? 0) > 1
      ? options.contextWindow
      : undefined;
  const contextOption = context?.options.find((option) => option.id === context.selected);
  const modelMeta = blocked
    ? ""
    : (contextOption?.label ?? formatModelContextMeta(options.entry, t));
  const accessibleStatus = coolingDown
    ? t("chat.modelControls.cooldownStatus")
    : needsAuth
      ? t("modelSetup.candidates.signInNeeded")
      : options.entry.unavailableReason === "unsupported-runtime"
        ? t("chat.modelControls.runtimeUnavailable")
        : "";
  return {
    selected,
    context: contextOption ? context : undefined,
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
    keywords: [
      options.entry.isDefault ? defaultLabel : "",
      runtimeLabel,
      options.entry.agentRuntimeId,
    ]
      .join(" ")
      .toLocaleLowerCase(),
    providerLabel: defaultProviderLabel(
      options.entry.provider,
      options.entry.presentation,
    ).toLocaleLowerCase(),
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
  const providerDisplayLabel = (provider: string) =>
    defaultProviderLabel(provider, props.entry.presentation);
  const search = useContext(ChatModelSearchContext);
  const defaultLabel = createMemo(() =>
    props.entry.isDefault ? t("chat.modelControls.default") : "",
  );
  const key = createMemo(() => props.rowKey ?? modelPickerOptionKey(props.entry));
  // Query changes should reach only rows whose displayed search facts changed.
  const rank = createMemo(() => search?.row(key())?.rank);
  const hidden = createMemo(() => search?.row(key())?.hidden ?? false);
  const highlighted = createMemo(() => search?.isHighlighted(key()));
  const phone = createMediaQuery("(max-width: 640px)");
  const blocked = () =>
    props.disabled ||
    props.presentation.blocked ||
    Boolean(props.entry.disabled && !props.presentation.resetsPin);
  function FavoriteButton() {
    const [popped, setPopped] = createSignal(false);
    return (
      <button
        type="button"
        class="chat-controls__model-favorite"
        data-chat-model-favorite={props.entry.value}
        data-popped={popped() ? "" : undefined}
        aria-pressed={props.favorite?.selected ? "true" : "false"}
        // Unavailable models still allow favorites; override the row's disabled state.
        aria-disabled={props.favorite?.disabled ? "true" : "false"}
        aria-label={t(
          props.favorite?.selected ? "chat.modelFavorites.remove" : "chat.modelFavorites.add",
          {
            model: [props.presentation.modelLabel, props.presentation.runtimeLabel]
              .filter(Boolean)
              .join(" · "),
          },
        )}
        disabled={props.favorite?.disabled}
        onKeyDown={(event) => {
          // The star is independent of model selection and picker shortcuts.
          if (event.key !== "Escape" && event.key !== "Tab") {
            event.stopPropagation();
          }
        }}
        onClick={(event) => {
          event.stopPropagation();
          setPopped(!props.favorite?.selected);
          props.favorite?.onToggle(event);
        }}
        onAnimationEnd={() => setPopped(false)}
      >
        <Icon name="star" />
      </button>
    );
  }
  return (
    <div
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
      data-chat-model-keywords={[
        defaultLabel(),
        props.presentation.runtimeLabel,
        props.entry.agentRuntimeId,
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
      aria-label={[
        props.presentation.modelLabel,
        props.presentation.runtimeLabel,
        props.presentation.accessibleStatus,
        props.presentation.chatOnlyHelp,
      ]
        .filter(Boolean)
        .join(". ")}
      tabindex={blocked() ? -1 : 0}
      aria-disabled={blocked() ? "true" : undefined}
      data-chat-model-auth-blocked={props.presentation.needsAuth ? "" : undefined}
      data-chat-model-cooldown={props.presentation.coolingDown ? "" : undefined}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          if (!blocked()) {
            event.currentTarget.click();
          }
        }
      }}
      onClick={(event) => {
        if (!blocked()) {
          props.onSelect(props.entry, event);
        }
      }}
    >
      <span class="chat-controls__model-option-provider">
        <ChatModelProviderIcon
          provider={props.entry.provider}
          presentation={props.entry.presentation}
        />
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
          <Show when={props.favorite && !phone()}>
            <FavoriteButton />
          </Show>
          <Show when={props.presentation.modelMeta || props.presentation.cooldownUntil}>
            <span
              class={[
                "chat-controls__model-option-meta",
                { "chat-controls__context-placeholder": Boolean(props.presentation.context) },
              ]}
            >
              <Show when={props.presentation.cooldownUntil} fallback={props.presentation.modelMeta}>
                {(until) => <ChatModelCooldown until={until()} />}
              </Show>
              <Show when={props.presentation.context}>
                <Icon name="chevronDown" />
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
      <Show when={props.favorite && phone()}>
        <FavoriteButton />
      </Show>
    </div>
  );
}

export function ChatModelPickerOption(props: ChatModelPickerOptionProps) {
  const presentation = createOptionPresentation(props);
  return (
    <div
      class={[
        "chat-controls__model-option-wrap",
        { "chat-controls__model-option-wrap--context": Boolean(presentation().context) },
      ]}
    >
      <Tooltip
        class="chat-controls__model-tooltip"
        content={[presentation().modelLabel, presentation().detail].filter(Boolean).join(". ")}
        delay={800}
        describe={Boolean(presentation().detail)}
      >
        <ModelOptionButton {...props} presentation={presentation()} />
      </Tooltip>
      <Show when={presentation().context}>
        {(context) => (
          <ChatContextWindowControl contextWindow={context()} sessionKey={props.sessionKey!} />
        )}
      </Show>
    </div>
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

export function ChatModelPickerTargets(panel: {
  group: ChatModelPickerTargetGroup;
  disabled: boolean;
  startIndex: number;
  window: ReturnType<typeof createModelPickerWindow>;
  onSelect: ChatModelPickerTargetOptionProps["onSelect"];
  onRetry: ChatModelPickerParams["onTargetRetry"];
}) {
  function TargetOptions(props: { group: ChatModelPickerTargetGroup }) {
    const options = createMemo(() => props.group.completion.promise);
    return (
      <ModelList label={props.group.label} id={`target:${props.group.id}`}>
        <For
          each={options().filter((entry) =>
            panel.window.has(`target:${props.group.id}:${entry.value}`),
          )}
          keyed={(entry) => entry.value}
        >
          {(entry) => {
            const key = createMemo(() => `target:${props.group.id}:${entry().value}`);
            return (
              <>
                {panel.window.renderRow(key(), () => (
                  <ChatModelPickerTargetOption
                    disabled={panel.disabled}
                    entry={entry()}
                    groupId={props.group.id}
                    groupLabel={props.group.label}
                    index={
                      panel.startIndex +
                      props.group.options.findIndex((option) => option.value === entry().value)
                    }
                    onSelect={panel.onSelect}
                  />
                ))}
              </>
            );
          }}
        </For>
      </ModelList>
    );
  }
  function TargetState(props: { group: ChatModelPickerTargetGroup; error?: boolean }) {
    return (
      <>
        {panel.window.renderRow(`state:target:${props.group.id}`, () => (
          <ChatModelCatalogState
            state={{ hasSnapshot: false, status: props.error ? "error" : "loading" }}
            hasOptions={false}
            hasSelectableOptions={false}
            errorLabel={props.group.errorLabel}
            retryTarget={
              panel.onRetry
                ? {
                    disabled: panel.disabled,
                    groupId: props.group.id,
                    onRetry: panel.onRetry!,
                  }
                : undefined
            }
          />
        ))}
        <ModelList label={props.group.label} id={`target:${props.group.id}`}>
          {null}
        </ModelList>
      </>
    );
  }

  return (
    <Show when={panel.group.completion} keyed>
      <Errored fallback={() => <TargetState group={panel.group} error />}>
        <Loading fallback={<TargetState group={panel.group} />}>
          <TargetOptions group={panel.group} />
        </Loading>
      </Errored>
    </Show>
  );
}
