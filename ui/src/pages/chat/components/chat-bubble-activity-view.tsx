import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";

/** Native details retains its local open state while activity content streams. */
export function ChatBubbleActivity(props: {
  label: string;
  children: JSX.Element;
  open?: boolean;
}) {
  // Equal option refreshes must not undo a reader's native disclosure toggle.
  const open = createMemo(() => props.open);
  return (
    <details class="chat-bubble-activity" open={open()}>
      <summary class="chat-bubble-activity__summary" aria-label={props.label}>
        <span>{props.label}</span>
        <span aria-hidden="true">›</span>
      </summary>
      <div class="chat-bubble-activity__details">{props.children}</div>
    </details>
  );
}
