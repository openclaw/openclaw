import { Errored, For, Show } from "solid-js";
import { formatModelRuntimeLabel } from "../../../lib/model-runtime-label.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { createChatModelFavorites } from "./chat-model-favorites.ts";
import { modelPickerOptionKey, type ChatModelPickerOption } from "./chat-model-picker-options.ts";

export function ChatModelFavoritesEditor(props: {
  favorites: ReturnType<typeof createChatModelFavorites>;
  managing: boolean;
  onManagingChange: (open: boolean) => void;
  options: ChatModelPickerOption[];
}) {
  return (
    <Show when={props.favorites.available()}>
      <details
        class="chat-controls__favorites-editor muted"
        style={{ padding: "7px" }}
        open={props.managing}
        onToggle={(event) => props.onManagingChange(event.currentTarget.open)}
      >
        <summary>{t("chat.modelControls.manageFavorites")}</summary>
        <Show when={props.managing}>
          <div
            class="grid"
            style={{
              gap: "6px",
              "max-height": "180px",
              "overflow-y": "auto",
              "margin-top": "7px",
            }}
            role="group"
            aria-label={t("chat.modelControls.manageFavorites")}
          >
            <For each={props.options} keyed={modelPickerOptionKey}>
              {(entry) => (
                <label
                  class="chat-controls__favorite-choice row"
                  style={{ gap: "8px", "min-width": "0" }}
                >
                  <input
                    type="checkbox"
                    data-chat-model-favorite={modelPickerOptionKey(entry())}
                    checked={props.favorites.keys().includes(modelPickerOptionKey(entry()))}
                    disabled={props.favorites.disabled()}
                    onClick={(event) => {
                      event.preventDefault();
                      props.favorites.toggle(modelPickerOptionKey(entry()));
                    }}
                  />
                  <span
                    style={{
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                      "white-space": "nowrap",
                    }}
                  >
                    {[
                      entry().label,
                      formatModelRuntimeLabel(entry().provider, entry().agentRuntimeId)?.label,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </label>
              )}
            </For>
          </div>
        </Show>
      </details>
      <Show when={props.favorites.snapshot().error}>
        <div role="alert">
          {props.favorites.snapshot().error}
          <button type="button" onClick={() => props.favorites.retry()}>
            {t("common.retry")}
          </button>
        </div>
      </Show>
      <Show when={!props.favorites.saving()}>
        <Errored fallback={(error) => <div role="alert">{String(error())}</div>}>
          {props.favorites.outcome()}
        </Errored>
      </Show>
    </Show>
  );
}
