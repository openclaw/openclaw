import { For, Show } from "solid-js";
import { currentThemeBranding } from "../../../app/theme-branding.ts";
import { ElapsedTime } from "../../../components/elapsed-time.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { ThemeBrandIcon } from "../../../components/theme-brand-icon.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import "./chat-subagent-activity.css";
import type { ChatSubagentActivity } from "../chat-subagent-wait.ts";

registerEnglishCatalog(registerChatSessionEnglish);

export type SubagentActivityProps = {
  rows: readonly ChatSubagentActivity[];
  onOpenSubagent?: (key: string) => void;
  onOpenSession?: (key: string) => void;
  compact?: boolean;
  presented?: boolean;
  /** Limits rendering and narration subscriptions to the displayed rows. */
  limit?: number;
  turnStartedAt?: number;
};

const STATUS_KEYS = {
  queued: "common.queued",
  running: "common.running",
  waiting: "chat.waitingOnSubagents",
  done: "common.completed",
  failed: "common.failed",
  stopped: "chat.sessionDetails.stopped",
} as const;

function SubagentActivityRow(props: SubagentActivityProps & { row: ChatSubagentActivity }) {
  const status = () => t(STATUS_KEYS[props.row.status]);
  const open = () =>
    props.row.listed ? (props.onOpenSubagent ?? props.onOpenSession) : props.onOpenSession;
  const steps = () =>
    props.row.progress &&
    t("chat.sessionDetails.planSteps", {
      completed: String(props.row.progress.completed),
      total: String(props.row.progress.total),
    });
  const description = () =>
    [props.row.label, status(), props.row.activity, steps()].filter(Boolean).join(". ");
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
          data-status={props.row.status}
          style={`--chat-details-avatar-hue: ${fnv1aUtf16(props.row.key) % 360}`}
          aria-hidden="true"
        >
          <Icon name="bot" />
        </span>
      </Show>
      <span class="chat-subagent-activity__name">{props.row.label}</span>
      <Show when={!props.compact}>
        <span class="chat-subagent-activity__separator" aria-hidden="true">
          ·
        </span>
      </Show>
      <span class="chat-subagent-activity__status">{props.row.activity || status()}</span>
      <Show when={props.compact}>
        <span class="chat-subagent-activity__elapsed-compact" aria-hidden="true">
          <Show when={props.row.status !== "queued" && props.row.session.startedAt}>
            {(startedAt) => (
              <ElapsedTime startMs={startedAt()} endMs={props.row.session.endedAt ?? null} />
            )}
          </Show>
        </span>
        <Show when={props.row.progress}>
          {(progress) => (
            <span class="chat-subagent-activity__steps" aria-hidden="true">
              <meter
                class="chat-details__meter"
                min={0}
                max={progress().total}
                value={Math.min(progress().completed, progress().total)}
              />
              {progress().completed}/{progress().total}
            </span>
          )}
        </Show>
      </Show>
    </>
  );
  return (
    <div role="listitem" data-subagent-session-key={props.row.key}>
      <Show
        when={open()}
        fallback={
          <div
            class={[
              "chat-subagent-activity__row",
              { "chat-subagent-activity__row--preview": Boolean(props.row.activity) },
            ]}
            title={description()}
          >
            {content()}
          </div>
        }
      >
        <button
          class={[
            "chat-subagent-activity__row",
            { "chat-subagent-activity__row--preview": Boolean(props.row.activity) },
          ]}
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
          <For
            each={props.limit === undefined ? props.rows : props.rows.slice(0, props.limit)}
            keyed={(row) => row.key}
          >
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
            <ElapsedTime startMs={props.turnStartedAt} />
          </span>
        </Show>
      </div>
    </Show>
  );
}
