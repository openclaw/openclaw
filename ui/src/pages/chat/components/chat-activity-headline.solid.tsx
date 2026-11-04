import { createMemo, createSignal, For, Show, useContext } from "solid-js";
import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { resolveToolDisplayIcon } from "../../../lib/chat/tool-display-icon.ts";
import { createInterval } from "../../../lib/reactive/timers.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import type { PluginToolIcons } from "../chat-tool-icon-controller.ts";
import type { ActivityHeadline } from "./chat-activity-headline-selection.ts";
import { ChatToolIcon } from "./chat-tool-card-chrome.tsx";

export type ChatActivityHeadlineProps = {
  bubbleMode?: boolean;
  contentRef?: (element: HTMLSpanElement) => void;
  scope: string;
  activity: ActivityHeadline | undefined;
  summary: string;
  currentActivity?: readonly AgentActivityItem[];
  pluginToolIcons?: PluginToolIcons;
  outcomes?: readonly string[];
};

/** One disclosure owns its readable cadence; fast calls replace pending copy, not a queue. */
export function ChatActivityHeadline(props: ChatActivityHeadlineProps) {
  const presented = useContext(ContentPresentation);
  const [cadence, advanceCadence] = createSignal(0);
  const display = createMemo<{
    scope: string;
    active: boolean;
    headline: ActivityHeadline | undefined;
    shownAt: number;
    held: boolean;
  }>((previous) => {
    cadence();
    const active = presented();
    const scope = props.scope;
    const activity = props.activity;
    const currentActivity = props.currentActivity;
    const now = Date.now();
    if (!active) {
      return {
        scope: previous?.scope ?? scope,
        active: false,
        headline: previous?.headline,
        shownAt: previous?.shownAt ?? now,
        held: false,
      };
    }
    const reset = previous?.scope !== scope;
    const shown = reset ? undefined : previous?.headline;
    if (
      !activity ||
      !shown ||
      !previous?.active ||
      activity.status === "failed" ||
      activity.status === "blocked" ||
      shown.key === activity.key ||
      now - previous.shownAt >= 3_000
    ) {
      return {
        scope,
        active,
        headline: activity,
        shownAt:
          reset || shown?.key !== activity?.key || shown?.title !== activity?.title
            ? now
            : (previous?.shownAt ?? now),
        held: false,
      };
    }
    // Held copy follows the original operation's current outcome while its deadline stays fixed.
    const current = currentActivity?.find((item) => (item.toolCallId ?? item.itemId) === shown.key);
    return {
      scope,
      active,
      headline: currentActivity ? { ...shown, status: current?.status } : shown,
      shownAt: previous.shownAt,
      held: true,
    };
  });
  createInterval(
    () => advanceCadence((value) => value + 1),
    () => {
      const current = display();
      return current.held ? Math.max(1, current.shownAt + 3_000 - Date.now()) : undefined;
    },
  );
  const shown = () => display().headline;
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
          keyed
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
                {
                  "chat-activity-group__label--running text-shimmer": shown()?.status === "running",
                },
              ]}
            >
              {title}
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
