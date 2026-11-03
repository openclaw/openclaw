import { For, Show, useContext } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerProviderUsageEnglish } from "../../../i18n/locales/en-provider-usage.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatModelAccountSection } from "./chat-model-account-control.ts";
import { ChatModelSearchContext } from "./chat-model-picker-search.ts";

registerProviderUsageEnglish();

export function ChatModelAccountSectionView(
  props: Omit<ReturnType<ChatModelAccountSection["viewProps"]>, "onRetry"> & {
    onRetry?: () => void;
  },
) {
  const search = useContext(ChatModelSearchContext);
  return (
    <section
      class="chat-controls__provider-model-group chat-controls__account-section"
      data-chat-account-selection={props.selectionKind}
      aria-label={t("chat.modelAccounts.section")}
    >
      <button
        class="chat-controls__provider-heading chat-controls__account-heading"
        type="button"
        data-chat-account-group-toggle
        data-chat-model-group-toggle
        aria-expanded={props.open ? "true" : "false"}
        aria-controls={search?.listId("accounts")}
        disabled={props.disabled}
        onClick={() => props.onToggle()}
      >
        <span class="chat-controls__provider-label">{t("chat.modelAccounts.section")}</span>
        <span class="chat-controls__account-selection">{props.selectedIdentity}</span>
        <span class="chat-controls__inline-select-chevron" aria-hidden="true">
          <Icon name={props.open ? "chevronUp" : "chevronDown"} />
        </span>
      </button>
      <div
        id={search?.listId("accounts")}
        class="chat-controls__provider-model-list chat-controls__account-popover"
        hidden={!props.open}
        data-chat-model-list="true"
        role="listbox"
        aria-label={t("chat.modelAccounts.section")}
      >
        <For
          each={props.options.filter(
            (option) => !props.error || option.value === "current" || option.value === "manage",
          )}
          keyed={(option) => option.value}
        >
          {(option, index) => {
            return (
              <>
                <button
                  ref={search?.rowRef(() => `account:${option().value}`)}
                  id={search?.optionId(`account:${option().value}`)}
                  class={[
                    "chat-controls__inline-select-option chat-controls__model-option",
                    {
                      "chat-controls__inline-select-option--selected":
                        option().value === props.currentValue,
                    },
                  ]}
                  type="button"
                  role="option"
                  aria-selected={option().value === props.currentValue ? "true" : "false"}
                  aria-posinset={search?.row(`account:${option().value}`)?.position}
                  aria-setsize={search?.row(`account:${option().value}`)?.size}
                  data-chat-account-option={option().value}
                  data-chat-model-option={`account:${option().value}`}
                  data-chat-model-key={`account:${option().value}`}
                  data-chat-model-rank={search?.row(`account:${option().value}`)?.rank}
                  data-chat-model-highlighted={
                    search?.isHighlighted(`account:${option().value}`) ? "" : undefined
                  }
                  style={{ "--chat-model-rank": search?.row(`account:${option().value}`)?.rank }}
                  data-chat-model-index={props.startIndex + index()}
                  data-chat-model-name={option().label.toLocaleLowerCase()}
                  data-chat-model-keywords={option().description?.toLocaleLowerCase() ?? ""}
                  data-chat-model-provider-label="account"
                  hidden={search?.row(`account:${option().value}`)?.hidden ?? !props.open}
                  aria-disabled={option().disabled ? "true" : undefined}
                  disabled={
                    props.disabled || Boolean(option().disabled && option().value !== "more")
                  }
                  onClick={(event) => props.onSelect(option().value, event)}
                >
                  <span class="chat-controls__model-option-copy">
                    <span class="chat-controls__model-option-name">{option().label}</span>
                    <Show when={option().description}>
                      <span class="chat-controls__auth-meta">
                        <span class="chat-controls__model-option-name">{option().description}</span>
                      </span>
                    </Show>
                  </span>
                  <Show when={option().windows?.length}>
                    <span class="chat-controls__account-usage">
                      <For each={option().windows}>
                        {(window) => (
                          <span data-low={window.usedPercent > 85 ? "" : undefined}>
                            <span>
                              {t(
                                window.label === "5h"
                                  ? "chat.modelControls.usage5h"
                                  : "chat.modelControls.usageWeek",
                              )}
                            </span>{" "}
                            {t("usage.providerUsage.remaining", {
                              percent: String(
                                Math.max(0, Math.min(100, Math.round(100 - window.usedPercent))),
                              ),
                            })}
                          </span>
                        )}
                      </For>
                    </span>
                  </Show>
                  <span class="chat-controls__model-option-action">
                    <Show when={option().value === props.currentValue}>
                      <span class="chat-controls__inline-select-check" aria-hidden="true">
                        <Icon name="check" />
                      </span>
                    </Show>
                  </span>
                </button>
                <Show when={props.error && option().value === "current"}>
                  <span class="chat-controls__account-error" role="alert">
                    {props.error}{" "}
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onRetry?.();
                      }}
                    >
                      {t("common.retry")}
                    </button>
                  </span>
                </Show>
              </>
            );
          }}
        </For>
      </div>
    </section>
  );
}
