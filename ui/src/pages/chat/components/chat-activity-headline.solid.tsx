import { createMemo, createSignal, For, Show, useContext } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { resolveToolDisplayIcon } from "../../../lib/chat/tool-display-icon.ts";
import { t } from "../../../lib/reactive/i18n.ts";
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
  resolveActivity?: (key: string) => ActivityHeadline | undefined;
  summary: string;
  pluginToolIcons?: PluginToolIcons;
  outcomes?: readonly string[];
};

/** Coalesce identity changes, never the recorded outcome or action wording. */
export function ChatActivityHeadline(props: ChatActivityHeadlineProps) {
  const presented = useContext(ContentPresentation);
  const [tick, advance] = createSignal(0);
  const resolve = (key: string) =>
    props.activity?.key === key ? props.activity : props.resolveActivity?.(key);
  const selection = createMemo<{
    scope: string;
    key: string | undefined;
    shownAt: number;
    held: boolean;
    active: boolean;
  }>((previous) => {
    tick();
    const active = presented();
    const scope = props.scope;
    const current = props.activity;
    const now = Date.now();
    const held = previous?.key ? resolve(previous.key) : undefined;
    const keep = Boolean(
      active &&
      previous?.active &&
      previous.scope === scope &&
      held !== undefined &&
      current?.status === "running" &&
      held.key !== current.key &&
      now - previous.shownAt < 1_000,
    );
    return {
      scope,
      key: keep ? previous?.key : current?.key,
      shownAt:
        keep || (previous?.scope === scope && previous.key === current?.key)
          ? (previous?.shownAt ?? now)
          : now,
      held: keep,
      active,
    };
  });
  createInterval(
    () => advance((value) => value + 1),
    () => (selection().held ? Math.max(1, selection().shownAt + 1_000 - Date.now()) : undefined),
  );
  const shown = createMemo<ActivityHeadline | undefined>((previous) => {
    if (!presented()) {
      return previous;
    }
    const key = selection().key;
    return key ? resolve(key) : undefined;
  });
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
        <Show when={Boolean(shown()?.title) || !props.bubbleMode}>
          <span
            class={[
              "chat-activity-group__label",
              shown()?.title && "chat-activity-group__label--live",
              shown()?.status === "running" && "chat-activity-group__label--running text-shimmer",
            ]}
          >
            {shown()?.title || props.summary}
            {!props.bubbleMode && shown()?.title && shown()?.status === "running" ? "…" : ""}
          </span>
        </Show>
      </span>
      <Show when={shown()?.title}>
        <Show when={shown()?.status === "failed" || shown()?.status === "skipped"}>
          <span class="chat-activity-group__outcome muted">
            {t(shown()?.status === "failed" ? "chat.toolCards.failed" : "chat.toolCards.skipped")}
          </span>
        </Show>
        <For each={props.outcomes}>
          {(label) => <span class="chat-activity-group__outcome muted">{label}</span>}
        </For>
      </Show>
    </>
  );
}
