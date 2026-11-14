import type { JSX } from "@solidjs/web";
import { createMemo, createUniqueId, For, Show, useContext } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Popover } from "../../../components/solid/popover.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatModelAccountSection } from "./chat-model-account-control.ts";
import { ChatModelSearchContext } from "./chat-model-picker-search.ts";
import type { ModelPickerRowRenderer } from "./chat-model-picker-window.tsx";

export function ChatModelAccountSectionView(
  props: ReturnType<ChatModelAccountSection["viewProps"]>,
) {
  const id = createUniqueId();
  return (
    <span class="chat-controls__account-section" data-chat-account-selection={props.selectionKind}>
      <Popover
        id={id}
        label={t("chat.modelAccounts.section")}
        triggerClass="chat-controls__account-trigger"
        class="chat-controls__settings-popover chat-controls__account-popover"
        placement="bottom-start"
        sameRoot
        disabled={props.disabled}
        open={props.open}
        onOpenChange={(open) => {
          if (open !== props.open) {
            props.onToggle();
          }
        }}
        trigger={
          <>
            <span class="chat-controls__account-selection">
              {props.options.find((option) => option.value === props.currentValue)?.label ??
                props.selectedIdentity}
            </span>
            <Icon name="chevronDown" />
          </>
        }
      >
        <ChatModelAccountOptions {...props} />
      </Popover>
    </span>
  );
}

export function ChatModelAccountOptions(
  props: ReturnType<ChatModelAccountSection["viewProps"]> & { renderRow?: ModelPickerRowRenderer },
) {
  const search = useContext(ChatModelSearchContext);
  const renderRow = createMemo(() => props.renderRow);
  const row = (key: string, render: () => JSX.Element) => {
    const renderer = renderRow();
    return renderer ? renderer(key, render) : render();
  };
  return (
    <>
      <div
        id={search?.listId("accounts")}
        class="chat-controls__provider-model-list"
        data-chat-model-list="true"
        role="listbox"
        aria-label={t("chat.modelAccounts.section")}
      >
        <For each={props.options} keyed={(option) => option.value}>
          {(option, index) => {
            const key = createMemo(() => `account:${option().value}`);
            return (
              <>
                {row(key(), () => (
                  <div
                    class={
                      option().value === "manage" ? "chat-controls__account-footer" : undefined
                    }
                  >
                    <button
                      ref={search?.rowRef(() => `account:${option().value}`)}
                      id={search?.optionId(`account:${option().value}`)}
                      class={[
                        "chat-controls__inline-select-option chat-controls__model-option",
                        {
                          "chat-controls__account-row": !["loading", "more", "manage"].includes(
                            option().value,
                          ),
                          "chat-controls__account-manage": option().value === "manage",
                        },
                        {
                          "chat-controls__inline-select-option--selected":
                            option().value === props.currentValue,
                        },
                      ]}
                      data-has-description={option().description ? "" : undefined}
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
                      style={{
                        "--chat-model-rank": search?.row(`account:${option().value}`)?.rank,
                      }}
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
                      <Show when={option().value === "manage"}>
                        <span class="chat-controls__account-gear" aria-hidden="true">
                          <Icon name="settings" />
                        </span>
                      </Show>
                      <span class="chat-controls__model-option-copy">
                        <span class="chat-controls__model-option-name">{option().label}</span>
                        <Show when={option().description}>
                          <span class="chat-controls__auth-meta">
                            <span class="chat-controls__model-option-name">
                              {option().description}
                            </span>
                          </span>
                        </Show>
                      </span>
                      <span class="chat-controls__model-option-action">
                        <Show when={option().value === props.currentValue}>
                          <span class="chat-controls__inline-select-check" aria-hidden="true">
                            <Icon name="check" />
                          </span>
                        </Show>
                      </span>
                    </button>
                  </div>
                ))}
              </>
            );
          }}
        </For>
      </div>
      <Show when={props.error}>
        {row("error:accounts", () => (
          <span class="chat-controls__account-error" role="alert">
            {props.error}
          </span>
        ))}
      </Show>
    </>
  );
}
