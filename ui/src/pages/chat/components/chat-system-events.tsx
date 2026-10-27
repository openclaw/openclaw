import { For, Show, createSignal } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { SystemEventGroup, SystemEventItem } from "../../../lib/chat/chat-types.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { ChatDivider } from "./chat-divider.tsx";
import { ChatNotice } from "./chat-notice-view.tsx";

registerEnglishCatalog(registerChatMessageMetadataEnglish);

function SystemEvent(props: { item: SystemEventItem }) {
  return (
    <>
      {props.item.kind === "notice" ? (
        <ChatNotice item={props.item} />
      ) : (
        <ChatDivider item={props.item} />
      )}
    </>
  );
}

export function ChatSystemEvents(props: { item: SystemEventGroup }) {
  const [expanded, setExpanded] = createSignal(false);
  const deliveryWarning = () =>
    props.item.events.some((event) => event.systemEvent === "delivery-warning");
  return (
    <details
      class="chat-system-events"
      data-chat-row-key={props.item.key}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary class="chat-system-events__summary">
        <span class="chat-system-events__line" aria-hidden="true" />
        <span class="chat-system-events__label">
          <span class="chat-system-events__chevron" aria-hidden="true">
            <Icon name="chevronRight" />
          </span>
          <span>
            {t(
              props.item.events.length === 1
                ? "chat.systemNotice.event"
                : "chat.systemNotice.events",
              { count: String(props.item.events.length) },
            )}
          </span>
          <Show when={deliveryWarning()}>
            <span class="chat-system-events__warning">
              {t("chat.systemNotice.updatesNotDelivered")}
            </span>
          </Show>
        </span>
        <span class="chat-system-events__line" aria-hidden="true" />
      </summary>
      <Show when={expanded()}>
        <div class="chat-system-events__body">
          <For each={props.item.events} keyed={(event) => event.key}>
            {(event) => <SystemEvent item={event()} />}
          </For>
        </div>
      </Show>
    </details>
  );
}
