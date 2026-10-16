import { For, Show } from "solid-js";
import { currentThemeBranding } from "../../../app/theme-branding.ts";
import "../../../components/elapsed-time.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { ThemeBrandIcon } from "../../../components/theme-brand-icon.tsx";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatSubagentActivity } from "../chat-subagent-wait.ts";
import "./chat-subagent-activity.css";

export type SubagentActivityProps = {
  rows: readonly ChatSubagentActivity[];
  onOpenSubagent?: (key: string) => void;
  onOpenSession?: (key: string) => void;
  compact?: boolean;
  turnStartedAt?: number;
};

function SubagentActivityRow(props: SubagentActivityProps & { row: ChatSubagentActivity }) {
  const status = () =>
    t(
      props.row.status === "queued"
        ? "common.queued"
        : props.row.status === "waiting"
          ? "chat.waitingOnSubagents"
          : "common.running",
    );
  const open = () =>
    props.row.listed ? (props.onOpenSubagent ?? props.onOpenSession) : props.onOpenSession;
  const description = () =>
    [props.row.label, status(), props.row.activity].filter(Boolean).join(". ");
  const content = () => (
    <>
      <Show
        when={props.compact}
        fallback={
          <span
            class={[
              "chat-subagent-activity__icon",
              { "chat-reading-indicator": props.row.status === "running" },
            ]}
            aria-hidden="true"
          >
            <Show when={props.row.status === "running"} fallback={<Icon name="clock" />}>
              <Show
                when={currentThemeBranding().brandIcon === "claw"}
                fallback={
                  <Show
                    when={currentThemeBranding().brandIcon === "mark"}
                    fallback={<ThemeBrandIcon />}
                  >
                    <Icon name="mark" />
                  </Show>
                }
              >
                <Icon name="claw" />
              </Show>
            </Show>
          </span>
        }
      >
        <span
          class="chat-details__agent-avatar"
          style={`--chat-details-avatar-hue: ${fnv1aUtf16(props.row.key) % 360}`}
          aria-hidden="true"
        >
          <Icon name="bot" />
        </span>
      </Show>
      <span class="chat-subagent-activity__name">{props.row.label}</span>
      <span class="chat-subagent-activity__status">{props.row.activity || status()}</span>
    </>
  );
  return (
    <div role="listitem" data-subagent-session-key={props.row.key}>
      <Show
        when={open()}
        fallback={
          <div class="chat-subagent-activity__row" title={description()}>
            {content()}
          </div>
        }
      >
        <button
          class="chat-subagent-activity__row"
          type="button"
          title={description()}
          aria-label={description()}
          onClick={() => open()?.(props.row.key)}
        >
          {content()}
        </button>
      </Show>
    </div>
  );
}

export function SubagentActivity(props: SubagentActivityProps) {
  return (
    <Show when={props.rows.length > 0}>
      <div class="chat-subagent-activity-shell">
        <div class="chat-subagent-activity" role="list" aria-label={t("chat.subagentsPanel.title")}>
          <For each={props.rows} keyed={(row) => row.key}>
            {(row) => <SubagentActivityRow {...props} row={row()} />}
          </For>
        </div>
        <Show when={props.turnStartedAt !== undefined}>
          <span
            class="chat-subagent-activity__elapsed"
            title={t("chat.turnElapsed")}
            aria-live="off"
          >
            <span class="sr-only">{t("chat.turnElapsed")}: </span>
            <openclaw-elapsed-time prop:startMs={props.turnStartedAt} />
          </span>
        </Show>
      </div>
    </Show>
  );
}
