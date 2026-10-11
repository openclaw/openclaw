import type { JSX } from "@solidjs/web";
import { t } from "../../../lib/reactive/i18n.ts";

export function ChatBubbleDots(props: { working?: boolean }) {
  return (
    <span
      class={["chat-bubble-dots", { "chat-bubble-dots--working": props.working }]}
      aria-hidden="true"
    >
      <span />
      <span />
      <span />
    </span>
  );
}

/** Native details retains its local open state while activity content streams. */
export function ChatBubbleActivity(props: {
  label: string;
  working?: boolean;
  children: JSX.Element;
}) {
  return (
    <details class="chat-bubble-activity">
      <summary
        class="chat-bubble-activity__summary"
        aria-label={props.label}
        title={t("chat.view.activityDetails")}
      >
        <ChatBubbleDots working={props.working} />
      </summary>
      <div class="chat-bubble-activity__details">{props.children}</div>
    </details>
  );
}
