import { createMemo, For, Show, useContext } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { resolveToolDisplayIcon } from "../../../lib/chat/tool-display-icon.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import type { PluginToolIcons } from "../chat-tool-icon-controller.ts";
import type { ActivityHeadline } from "./chat-activity-headline-selection.ts";
import { ChatToolIcon } from "./chat-tool-card-chrome.tsx";

export type ChatActivityHeadlineProps = {
  bubbleMode?: boolean;
  contentRef?: (element: HTMLSpanElement) => void;
  activity: ActivityHeadline | undefined;
  summary: string;
  pluginToolIcons?: PluginToolIcons;
  outcomes?: readonly string[];
};

/** Recorded activity updates in place; completed actions never linger as running copy. */
export function ChatActivityHeadline(props: ChatActivityHeadlineProps) {
  const presented = useContext(ContentPresentation);
  const shown = createMemo<ActivityHeadline | undefined>((previous) =>
    presented() ? props.activity : previous,
  );
  const name = () => shown()?.name;
  return (
    <>
      <Show
        when={props.bubbleMode}
        fallback={
          <span
            class="chat-activity-group__icon"
            role={name() ? "img" : undefined}
            aria-label={name()}
            aria-hidden={name() ? undefined : "true"}
          >
            <Show when={name()} fallback={<Icon name="listTree" />}>
              {(tool) => (
                <ChatToolIcon
                  style={{ display: "contents" }}
                  name={shown()?.commandBearing ? "squareTerminal" : resolveToolDisplayIcon(tool())}
                  tool={{ toolName: tool(), pluginToolIcons: props.pluginToolIcons }}
                />
              )}
            </Show>
          </span>
        }
      >
        <span class="chat-bubble-dots chat-bubble-dots--working" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </Show>
      <span ref={(element) => props.contentRef?.(element)} class="chat-tool-disclosure__content">
        <Show
          when={shown()?.title}
          fallback={
            <Show when={!props.bubbleMode}>
              <span class="chat-activity-group__label">{props.summary}</span>
            </Show>
          }
        >
          {(title) => (
            <span
              class={[
                "chat-activity-group__label chat-activity-group__label--live",
                shown()?.status === "running" && "chat-activity-group__label--running text-shimmer",
              ]}
            >
              {title()}
              {!props.bubbleMode && shown()?.status === "running" ? "…" : ""}
            </span>
          )}
        </Show>
      </span>
      <Show when={shown()?.title}>
        <For each={props.outcomes}>
          {(label) => <span class="chat-activity-group__outcome muted">{label}</span>}
        </For>
      </Show>
    </>
  );
}
