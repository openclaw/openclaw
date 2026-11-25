import { createSignal, lazy, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { ChatCompaction } from "../../../lib/chat/chat-types.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

const CompactionDetails = lazy(() => import("./chat-compaction-details.tsx"), {
  export: "ChatCompactionDetails",
});

export function ChatCompactionActivity(props: { item: ChatCompaction }) {
  const [open, setOpen] = createSignal(false);
  return (
    <details
      class="chat-tool-msg-collapse chat-compaction-activity"
      data-chat-row-key={props.item.key}
      data-ts={String(props.item.timestamp)}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary class="chat-inline-disclosure chat-tool-msg-summary chat-tool-row">
        <span class="chat-tool-msg-summary__icon">
          <Icon name="layers" />
        </span>
        <span
          class={["chat-tool-row__title", { "text-shimmer": props.item.phase === "active" }]}
          role="status"
        >
          {props.item.label}
        </span>
        <span class="chat-tool-row__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </summary>
      <Show when={open()}>
        <ChatLazyBoundary>
          <CompactionDetails item={props.item} />
        </ChatLazyBoundary>
      </Show>
    </details>
  );
}
