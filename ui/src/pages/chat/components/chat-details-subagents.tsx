import { For, Show, createMemo } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { registerChatDetailsEnglish } from "../../../i18n/locales/en-chat-details.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import "./chat-details-subagents.css";
import "./chat-subagents-working.css";
import {
  isDetailsSubagentWorking as isWorking,
  projectDetailsSubagents,
  type DetailsSubagent as Subagent,
  type DetailsSubagents,
} from "../chat-details-snapshot.ts";

registerEnglishCatalog(registerChatSessionEnglish);
registerEnglishCatalog(registerChatDetailsEnglish);

export type ChatDetailsSubagentsProps = {
  /** Collection members, in native launch order. The caller owns roster selection. */
  rows: readonly Subagent[];
  presentation?: DetailsSubagents;
  /** Native mobile presentation, not the width of a desktop pane. */
  mobile: boolean;
  /** Render in the section header's trailing slot when its body is collapsed. */
  collapsed?: boolean;
  /** Localized “Working”, without the ellipsis used by common.working. */
  workingLabel: string;
  onOpenSubagent: (key: string) => void;
  /** Must request the collection explicitly, clearing any previously selected child. */
  onOpenSubagents: () => void;
};

const STATUS_KEYS = {
  queued: "common.queued",
  waiting: "chat.waitingOnSubagents",
  done: "activity.status.done",
  failed: "common.failed",
  stopped: "chat.sessionDetails.stopped",
} as const;

function statusLabel(row: Subagent, workingLabel: string) {
  return row.status === "running" ? workingLabel : t(STATUS_KEYS[row.status]);
}

/** Settled rows recede in the list so working children stay prominent. */
function isFinished(row: Subagent) {
  return row.status === "done" || row.status === "failed" || row.status === "stopped";
}

function SubagentAvatar(props: { row: Subagent; summary?: boolean }) {
  return (
    <span
      class="chat-details-subagents__avatar"
      style={{ "--subagent-avatar-hue": fnv1aUtf16(props.row.key) % 360 }}
      aria-hidden="true"
    >
      <Icon name="bot" />
      <Show when={!props.summary && (isWorking(props.row) || props.row.status === "done")}>
        <span class="chat-details-subagents__badge">
          <Show
            when={isWorking(props.row)}
            fallback={<Icon name="check" class="chat-details-subagents__check" />}
          >
            <span class="chat-details-subagents__spinner" />
          </Show>
        </span>
      </Show>
    </span>
  );
}

function SubagentRow(props: ChatDetailsSubagentsProps & { row: Subagent }) {
  const nameOverflow = useScrollState(true, false);
  return (
    <div role="listitem">
      <button
        type="button"
        class={[
          "chat-details-subagents__row",
          { "chat-details-subagents__row--finished": isFinished(props.row) },
        ]}
        data-subagent-session-key={props.row.key}
        aria-label={`${props.row.label} ${statusLabel(props.row, props.workingLabel)}`}
        onClick={() => props.onOpenSubagent(props.row.key)}
      >
        <SubagentAvatar row={props.row} />
        <span class="chat-details-subagents__name" ref={nameOverflow}>
          {props.row.label}
        </span>
        <span
          class={[
            "chat-details-subagents__status",
            {
              "sr-only":
                props.row.status === "done" || (props.mobile && props.row.status === "running"),
              "chat-details-subagents__working text-shimmer":
                !props.mobile && props.row.status === "running",
            },
          ]}
        >
          {statusLabel(props.row, props.workingLabel)}
        </span>
        <Show when={props.mobile}>
          <Icon name="chevronRight" class="chat-details-subagents__chevron" />
        </Show>
      </button>
    </div>
  );
}

/** Controlled Details content. The parent owns section chrome and navigation. */
export function ChatDetailsSubagents(props: ChatDetailsSubagentsProps) {
  const presentation = createMemo(
    () => props.presentation ?? projectDetailsSubagents(props.rows, props.mobile),
  );
  const workingCount = () =>
    presentation().counts.reduce((sum, row) => sum + (isWorking(row) ? row.count : 0), 0);
  const countLabel = (status: Subagent["status"]) =>
    status === "running" ? props.workingLabel : t(STATUS_KEYS[status]);

  return (
    <Show when={presentation().total > 0}>
      <Show
        when={!props.collapsed}
        fallback={
          <Show when={workingCount() > 0}>
            <span
              class="chat-details-subagents__collapsed"
              role="img"
              aria-label={
                workingCount() === 1
                  ? t("chat.subagentsRunningOne")
                  : t("chat.subagentsRunning", { count: String(workingCount()) })
              }
            >
              <span class="session-run-spinner" aria-hidden="true" />
            </span>
          </Show>
        }
      >
        <div class={["chat-details-subagents", { "chat-details-subagents--mobile": props.mobile }]}>
          <Show
            when={presentation().total > (props.mobile ? 3 : 5)}
            fallback={
              <div
                class="chat-details-subagents__list"
                role="list"
                aria-label={t("chat.sessionDetails.subagents")}
              >
                <For each={presentation().rows} keyed={(row) => row.key}>
                  {(row) => <SubagentRow {...props} row={row()} />}
                </For>
              </div>
            }
          >
            <button
              type="button"
              class="chat-details-subagents__row chat-details-subagents__summary"
              onClick={() => props.onOpenSubagents()}
              aria-label={`${t("chat.sessionDetails.allSubagents")}. ${presentation()
                .counts.map((entry) => `${entry.count} ${countLabel(entry.status)}`)
                .join(", ")}`}
            >
              <span class="chat-details-subagents__stack" aria-hidden="true">
                <For each={presentation().rows} keyed={(row) => row.key}>
                  {(row) => <SubagentAvatar row={row()} summary />}
                </For>
              </span>
              <span class="chat-details-subagents__counts">
                <For each={presentation().counts} keyed={(entry) => entry.status}>
                  {(entry) => (
                    <span class="chat-details-subagents__count" data-status={entry().status}>
                      <span>{entry().count}</span>{" "}
                      <span class="chat-details-subagents__count-label">
                        {countLabel(entry().status)}
                      </span>
                    </span>
                  )}
                </For>
              </span>
              <Show when={props.mobile}>
                <Icon name="chevronRight" class="chat-details-subagents__chevron" />
              </Show>
            </button>
          </Show>
        </div>
      </Show>
    </Show>
  );
}
