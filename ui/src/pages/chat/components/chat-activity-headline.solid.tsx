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
  activity: ActivityHeadline | undefined;
  summary: string;
  pluginToolIcons?: PluginToolIcons;
  outcomes?: readonly string[];
};

/** One cadence owner for both the group's arrival and its changing headline. */
export function createActivityHeadlinePresentation(props: {
  scope: string;
  activity: ActivityHeadline | undefined;
  resolveActivity?: (key: string) => ActivityHeadline | undefined;
  /** Eligible live disclosure; history and expanded content bypass the hold. */
  active: boolean;
}) {
  const presented = useContext(ContentPresentation);
  const [tick, advance] = createSignal(0);
  const resolve = (key: string) =>
    props.activity?.key === key ? props.activity : props.resolveActivity?.(key);
  const selection = createMemo<{
    scope: string;
    key: string | undefined;
    shownAt: number;
    candidate: string | undefined;
    candidateAt: number;
    pendingAt: number | undefined;
    nextAt: number | undefined;
    active: boolean;
    revealed: boolean;
    pending: boolean;
  }>((previous) => {
    tick();
    const active = presented();
    const scope = props.scope;
    const current = props.activity;
    const now = Date.now();
    const held = previous?.key ? resolve(previous.key) : undefined;
    const candidateAt =
      previous?.scope === scope && previous.candidate === current?.key ? previous.candidateAt : now;
    const pendingAt = previous?.scope === scope ? (previous.pendingAt ?? now) : now;
    const urgent = current?.status === "failed" || current?.status === "blocked";
    const initialDeadline = Math.min(candidateAt + 200, pendingAt + 1_000);
    const pending =
      active &&
      props.active &&
      !urgent &&
      !(previous?.scope === scope && previous.revealed) &&
      now < initialDeadline;
    // Give transient replacements time to settle, but keep advancing during a
    // continuous burst. The displayed operation's outcome always refreshes immediately.
    const nextAt = Math.max(
      (previous?.shownAt ?? now) + 1_000,
      Math.min(candidateAt + 200, pendingAt + 1_000),
    );
    const keep = Boolean(
      !pending &&
      active &&
      props.active &&
      previous?.active &&
      previous.scope === scope &&
      held !== undefined &&
      current !== undefined &&
      !urgent &&
      held.key !== current.key &&
      now < nextAt,
    );
    return {
      scope,
      key: pending ? undefined : keep ? previous?.key : current?.key,
      shownAt:
        keep || (previous?.scope === scope && previous.key === current?.key)
          ? (previous?.shownAt ?? now)
          : now,
      candidate: current?.key,
      candidateAt,
      pendingAt: pending || keep ? pendingAt : undefined,
      nextAt: pending ? initialDeadline : keep ? nextAt : undefined,
      active,
      revealed: (previous?.scope === scope && previous.revealed) || (active && !pending),
      pending,
    };
  });
  createInterval(
    () => advance((value) => value + 1),
    () => {
      const nextAt = selection().nextAt;
      return nextAt === undefined ? undefined : Math.max(1, nextAt - Date.now());
    },
  );
  const shown = createMemo<ActivityHeadline | undefined>((previous) => {
    if (!presented()) {
      return previous;
    }
    const key = selection().key;
    return key ? resolve(key) : undefined;
  });
  return { selected: shown, pending: () => selection().pending };
}

export function ChatActivityHeadline(props: ChatActivityHeadlineProps) {
  const shown = () => props.activity;
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
