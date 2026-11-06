import { Dynamic } from "@solidjs/web";
import { For, Show } from "solid-js";
import { fnv1aUtf16 } from "../../../../../src/shared/fnv1a.js";
import { ElapsedTime } from "../../../components/elapsed-time.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatDetailsEnglish } from "../../../i18n/locales/en-chat-details.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import "./chat-subagent-activity.css";
import type { DetailsSubagent } from "../chat-details-snapshot.ts";
import type { ChatSubagentActivity } from "../chat-subagent-wait.ts";

registerEnglishCatalog(registerChatSessionEnglish);
registerEnglishCatalog(registerChatDetailsEnglish);

export type SubagentActivityProps = {
  rows: readonly ChatSubagentActivity[];
  /** A bounded display receipt, never a hydrated child roster. */
  presentation?: readonly DetailsSubagent[];
  onPresentation?: (rows: readonly ChatSubagentActivity[]) => void;
  onOpenSubagent?: (key: string) => void;
  onOpenSession?: (key: string) => void;
  /** Limits rendering to the displayed rows. */
  limit?: number;
};

const STATUS_KEYS = {
  queued: "common.queued",
  running: "common.running",
  waiting: "chat.waitingOnSubagents",
  done: "common.completed",
  failed: "common.failed",
  stopped: "chat.sessionDetails.stopped",
} as const;

function SubagentActivityRow(props: SubagentActivityProps & { row: DetailsSubagent }) {
  const status = () => t(STATUS_KEYS[props.row.status]);
  const open = () =>
    props.presentation
      ? undefined
      : props.row.listed
        ? (props.onOpenSubagent ?? props.onOpenSession)
        : props.onOpenSession;
  const steps = () =>
    props.row.progress &&
    t("chat.sessionDetails.planSteps", {
      completed: String(props.row.progress.completed),
      total: String(props.row.progress.total),
    });
  const description = () =>
    [props.row.label, status(), props.row.activity, steps()].filter(Boolean).join(". ");
  return (
    <div role="listitem" data-subagent-session-key={props.row.key}>
      <Dynamic
        component={open() ? "button" : "div"}
        class={[
          "chat-subagent-activity__row",
          { "chat-subagent-activity__row--preview": Boolean(props.row.activity) },
        ]}
        type={open() ? "button" : undefined}
        title={description()}
        aria-label={open() ? description() : undefined}
        onClick={open() ? () => open()?.(props.row.key) : undefined}
      >
        <span
          class="chat-details__agent-avatar"
          data-status={props.row.status}
          style={`--chat-details-avatar-hue: ${fnv1aUtf16(props.row.key) % 360}`}
          aria-hidden="true"
        >
          <Icon name="bot" />
        </span>
        <span
          ref={createTextOverflow(() => props.row.label)}
          class="chat-subagent-activity__name"
          title={props.row.label}
        >
          {props.row.label}
        </span>
        <span class="chat-subagent-activity__status">{props.row.activity || status()}</span>
        <span class="chat-subagent-activity__elapsed-compact" aria-hidden="true">
          <Show when={props.row.status !== "queued" && props.row.session?.startedAt}>
            {(startedAt) => (
              <ElapsedTime startMs={startedAt()} endMs={props.row.session?.endedAt ?? null} />
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
      </Dynamic>
    </div>
  );
}

export function SubagentActivity(props: SubagentActivityProps) {
  const rows = () => props.presentation ?? props.rows;
  return (
    <Show when={rows().length > 0}>
      <div class="chat-subagent-activity" role="list" aria-label={t("chat.subagentsPanel.title")}>
        <For
          each={props.limit === undefined ? rows() : rows().slice(0, props.limit)}
          keyed={(row) => row.key}
        >
          {(row) => <SubagentActivityRow {...props} row={row()} />}
        </For>
      </div>
    </Show>
  );
}
