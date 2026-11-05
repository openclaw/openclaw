import type { JSX } from "@solidjs/web";
import { createMemo, For, Show, useContext } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatModelAccountSection } from "./chat-model-account-control.ts";
import { handleModelOptionMouseEnter } from "./chat-model-picker-search-view.ts";
import { ChatModelSearchContext } from "./chat-model-picker-search.ts";
import type { ModelPickerRowRenderer } from "./chat-model-picker-window.tsx";

export function ChatModelAccountSectionView(
  props: ReturnType<ChatModelAccountSection["viewProps"]> & { renderRow?: ModelPickerRowRenderer },
) {
  const search = useContext(ChatModelSearchContext);
  const row = (key: string, render: () => JSX.Element) =>
    props.renderRow ? props.renderRow(key, render) : render();
  return (
    <section
      class="chat-controls__provider-model-group"
      data-chat-account-selection={props.selectionKind}
      aria-label={t("chat.modelAccounts.section")}
    >
      {row("heading:accounts", () => (
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
          <span class="chat-controls__provider-icon chat-controls__target-icon" aria-hidden="true">
            <Icon name="users" />
          </span>
          <span class="chat-controls__provider-label">{t("chat.modelAccounts.section")}</span>
          <span class="chat-controls__account-selection" title={props.selectedIdentity}>
            {props.selectedIdentity}
          </span>
          <span class="chat-controls__inline-select-chevron" aria-hidden="true">
            <Icon name={props.open ? "chevronUp" : "chevronDown"} />
          </span>
        </button>
      ))}
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
                    onMouseEnter={handleModelOptionMouseEnter}
                    onClick={(event) => props.onSelect(option().value, event)}
                  >
                    <span class="chat-controls__model-option-provider" aria-hidden="true">
                      <Icon name="users" />
                    </span>
                    <span class="chat-controls__model-option-copy">
                      <span class="chat-controls__model-option-name">{option().label}</span>
                      <Show when={option().description}>
                        <span class="chat-controls__auth-meta" title={option().description}>
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
    </section>
  );
}
