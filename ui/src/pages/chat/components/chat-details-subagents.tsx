import { For, Show, createMemo } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatSubagentActivity } from "../chat-subagent-wait.ts";
import "./chat-details-subagents.css";
import "./chat-subagents-working.css";

type Subagent = Pick<ChatSubagentActivity, "key" | "label" | "status">;

export type ChatDetailsSubagentsProps = {
  /** Collection members, in native launch order. The caller owns roster selection. */
  rows: readonly Subagent[];
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
const SUMMARY_ORDER = ["running", "waiting", "queued", "done", "failed", "stopped"] as const;

function isWorking(row: Subagent) {
  return row.status === "running" || row.status === "waiting";
}

function statusLabel(row: Subagent, workingLabel: string) {
  return row.status === "running" ? workingLabel : t(STATUS_KEYS[row.status]);
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
        class="chat-details-subagents__row"
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
              "chat-details-subagents__working": !props.mobile && props.row.status === "running",
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
  const working = createMemo(() => props.rows.filter(isWorking));
  const ordered = createMemo(() => [...working(), ...props.rows.filter((row) => !isWorking(row))]);
  const counts = createMemo(() =>
    SUMMARY_ORDER.map((status) => ({
      status,
      count: props.rows.filter((row) => row.status === status).length,
    })).filter((entry) => entry.count > 0),
  );
  const countLabel = (status: Subagent["status"]) =>
    status === "running" ? props.workingLabel : t(STATUS_KEYS[status]);

  return (
    <Show when={props.rows.length > 0}>
      <Show
        when={!props.collapsed}
        fallback={
          <Show when={working().length > 0}>
            <span
              class="chat-details-subagents__collapsed"
              role="img"
              aria-label={
                working().length === 1
                  ? t("chat.subagentsRunningOne")
                  : t("chat.subagentsRunning", { count: String(working().length) })
              }
            >
              <span class="chat-details-subagents__spinner" aria-hidden="true" />
            </span>
          </Show>
        }
      >
        <div class={["chat-details-subagents", { "chat-details-subagents--mobile": props.mobile }]}>
          <Show
            when={props.rows.length > (props.mobile ? 3 : 5)}
            fallback={
              <div
                class="chat-details-subagents__list"
                role="list"
                aria-label={t("chat.sessionDetails.subagents")}
              >
                <For each={ordered()} keyed={(row) => row.key}>
                  {(row) => <SubagentRow {...props} row={row()} />}
                </For>
              </div>
            }
          >
            <button
              type="button"
              class="chat-details-subagents__row chat-details-subagents__summary"
              onClick={() => props.onOpenSubagents()}
              aria-label={`${t("chat.sessionDetails.allSubagents")}. ${counts()
                .map((entry) => `${entry.count} ${countLabel(entry.status)}`)
                .join(", ")}`}
            >
              <span class="chat-details-subagents__stack" aria-hidden="true">
                <For each={ordered().slice(0, 4)} keyed={(row) => row.key}>
                  {(row) => <SubagentAvatar row={row()} summary />}
                </For>
              </span>
              <span class="chat-details-subagents__counts">
                <For each={counts()} keyed={(entry) => entry.status}>
                  {(entry) => (
                    <span class="chat-details-subagents__count">
                      <span>{entry().count}</span>{" "}
                      <Show
                        when={
                          props.mobile &&
                          (entry().status === "running" || entry().status === "done")
                        }
                      >
                        <Show
                          when={entry().status === "running"}
                          fallback={<Icon name="check" class="chat-details-subagents__check" />}
                        >
                          <span class="chat-details-subagents__spinner" aria-hidden="true" />
                        </Show>
                      </Show>
                      <span
                        class={[
                          "chat-details-subagents__count-label",
                          {
                            "sr-only":
                              props.mobile &&
                              (entry().status === "running" || entry().status === "done"),
                            "chat-details-subagents__working":
                              !props.mobile && entry().status === "running",
                          },
                        ]}
                      >
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
