import { Show } from "solid-js";
import type { ChatInputDeliveryEvent } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { registerChatInputDeliveryEnglish } from "../../../i18n/locales/en-chat-input-delivery.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatInputDeliveryEnglish);

const inputDeliveryLabels = {
  read: "chat.messages.inputDeliveryRead",
  unconfirmed: "chat.messages.inputDeliveryUnconfirmed",
  "not-steered": "chat.messages.inputDeliveryNotSteered",
} as const;
const inputDeliveryDescriptions = {
  read: "chat.messages.inputDeliveryReadDescription",
  unconfirmed: "chat.messages.inputDeliveryUnconfirmedDescription",
  "not-steered": "chat.messages.inputDeliveryNotSteeredDescription",
} as const;

export function ChatInputDeliveryStatus(props: {
  delivery: ChatInputDeliveryEvent["delivery"] | null;
}) {
  return (
    <Show when={props.delivery}>
      {(delivery) => (
        <span
          class="chat-input-delivery"
          data-delivery={delivery()}
          role="status"
          title={t(inputDeliveryDescriptions[delivery()])}
          aria-label={
            t(inputDeliveryLabels[delivery()]) + ": " + t(inputDeliveryDescriptions[delivery()])
          }
        >
          {t(inputDeliveryLabels[delivery()])}
        </span>
      )}
    </Show>
  );
}
