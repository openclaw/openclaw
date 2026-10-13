import type { JSX } from "@solidjs/web";

/** Native details retains its local open state while activity content streams. */
export function ChatBubbleActivity(props: { label: string; children: JSX.Element }) {
  return (
    <details class="chat-bubble-activity">
      <summary class="chat-bubble-activity__summary" aria-label={props.label}>
        <span>{props.label}</span>
        <span aria-hidden="true">›</span>
      </summary>
      <div class="chat-bubble-activity__details">{props.children}</div>
    </details>
  );
}
