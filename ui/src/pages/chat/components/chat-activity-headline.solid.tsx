import { createEffect, createSignal, For, onCleanup, Show, untrack, useContext } from "solid-js";
import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { resolveToolDisplayIcon } from "../../../lib/chat/tool-display-icon.ts";
import { LitContent, SolidContentPresentation } from "../../../lit/solid-content.tsx";
import type { PluginToolIcons } from "../chat-tool-icon-controller.ts";
import type { ActivityHeadline } from "./chat-activity-headline.ts";
import { renderToolIcon } from "./chat-tool-cards.ts";

export type ChatActivityHeadlineProps = {
  scope: string;
  activity: ActivityHeadline | undefined;
  summary: string;
  currentActivity?: readonly AgentActivityItem[];
  pluginToolIcons?: PluginToolIcons;
  outcomes?: readonly string[];
};

/** One disclosure owns its readable cadence; fast calls replace pending copy, not a queue. */
export function ChatActivityHeadline(props: ChatActivityHeadlineProps) {
  const [shown, setShown] = createSignal<ActivityHeadline>();
  const presented = useContext(SolidContentPresentation);
  let scope: string | undefined;
  let wasPresented = true;
  let shownAt = 0;
  let pending: ActivityHeadline | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = undefined;
  };
  const show = (activity: ActivityHeadline) => {
    const previous = untrack(shown);
    if (previous?.key !== activity.key || previous.title !== activity.title) {
      shownAt = Date.now();
    }
    setShown(activity);
  };
  createEffect(
    () => ({
      scope: props.scope,
      activity: props.activity,
      current: props.currentActivity,
      active: presented(),
    }),
    (input) => {
      clearTimer();
      if (!input.active) {
        wasPresented = false;
        return;
      }
      const reset = scope !== input.scope;
      scope = input.scope;
      const previous = reset ? undefined : untrack(shown);
      const activity = input.activity;
      const resume = !wasPresented;
      wasPresented = true;
      pending = undefined;
      if (!activity) {
        setShown(undefined);
        return;
      }
      const remaining = 3_000 - (Date.now() - shownAt);
      if (
        reset ||
        !previous ||
        resume ||
        activity.status === "failed" ||
        activity.status === "blocked" ||
        previous.key === activity.key ||
        remaining <= 0
      ) {
        if (reset) {
          shownAt = Date.now();
        }
        show(activity);
      } else {
        // Held copy follows the original operation's current outcome, not its obsolete running state.
        const current = input.current?.find(
          (item) => (item.toolCallId ?? item.itemId) === previous.key,
        );
        if (input.current) {
          setShown({ ...previous, status: current?.status });
        }
        pending = activity;
        timer = setTimeout(() => {
          timer = undefined;
          if (pending) {
            show(pending);
            pending = undefined;
          }
        }, remaining);
      }
    },
  );
  onCleanup(clearTimer);
  const name = () => shown()?.name;
  return (
    <>
      <span
        class="chat-activity-group__icon"
        role={name() ? "img" : undefined}
        aria-label={name()}
        aria-hidden={name() ? undefined : "true"}
        title={name()}
      >
        <Show when={name()} fallback={<Icon name="listTree" />}>
          {(tool) => (
            <LitContent
              value={renderToolIcon(
                shown()?.commandBearing ? "squareTerminal" : resolveToolDisplayIcon(tool()),
                { toolName: tool(), pluginToolIcons: props.pluginToolIcons },
              )}
            />
          )}
        </Show>
      </span>
      <span class="chat-tool-disclosure__content">
        <Show
          when={shown()?.title}
          keyed
          fallback={<span class="chat-activity-group__label">{props.summary}</span>}
        >
          {(title) => (
            <span class="chat-activity-group__label chat-activity-group__label--live">
              {title}
              {shown()?.status === "running" ? "…" : ""}
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
