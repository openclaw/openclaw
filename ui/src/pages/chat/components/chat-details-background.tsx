import type { JSX } from "@solidjs/web";
import { For, Show, createMemo, createSignal } from "solid-js";
import type { SessionProcessSummary } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { ElapsedTime } from "../../../components/elapsed-time.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  listSubagents,
  type ChatSubagentActivity as ChatSubagentActivityRow,
} from "../chat-subagent-wait.ts";
import type { ProcessesPanelData } from "../processes-panel-data.ts";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import { ChatSubagentActivity } from "./chat-subagent-activity-live.ts";

type Props = { details: ChatDetailsProps; presented: boolean };
type State = "running" | "queued" | "failed" | "stopped" | "done";
type Tally = Record<State, number>;

// The bar fills settled work from the start; the text leads with what is still going.
const SEGMENTS = ["done", "failed", "stopped", "running", "queued"] as const;
const SUMMARY = ["running", "queued", "done", "failed", "stopped"] as const;
// Rows list what still needs attention first: live work, then failures.
const ORDER: Record<State, number> = { running: 0, queued: 1, failed: 2, stopped: 3, done: 4 };
const PREVIEW_ROWS = 3;

function subagentState(row: ChatSubagentActivityRow): State {
  return row.status === "waiting" ? "running" : row.status;
}

function processState(row: SessionProcessSummary): State {
  return row.status === "running"
    ? "running"
    : row.status === "completed"
      ? "done"
      : row.status === "failed"
        ? "failed"
        : "stopped";
}

function tally<T>(rows: readonly T[], state: (row: T) => State): Tally {
  const counts = { running: 0, queued: 0, failed: 0, stopped: 0, done: 0 };
  for (const row of rows) {
    counts[state(row)] += 1;
  }
  return counts;
}

function attentionOrder<T>(rows: readonly T[], state: (row: T) => State): T[] {
  return rows.toSorted((a, b) => ORDER[state(a)] - ORDER[state(b)]);
}

/**
 * One collapsible kind of background work. The heading keeps the observed counts
 * and their bar visible while collapsed; the body previews the first rows.
 */
function BackgroundGroup(props: {
  kind: "subagents" | "processes";
  title: string;
  tally: Tally;
  total: number;
  icon: "bot" | "terminal";
  openAllLabel: string;
  onOpenAll?: () => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: JSX.Element;
}) {
  const summary = () =>
    SUMMARY.filter((state) => props.tally[state] > 0)
      .map((state) =>
        t(`chat.sessionDetails.tally.${state}`, { count: String(props.tally[state]) }),
      )
      .join(" · ");
  const hidden = () => props.total - PREVIEW_ROWS;
  return (
    <details class="chat-details__group" data-details-group={props.kind} open>
      <summary class="chat-details__caption chat-details__caption--tally">
        <span class="chat-details__caption-title">{props.title}</span>
        <span class="chat-details__tally-summary">{summary()}</span>
        <Icon name="chevronDown" />
        <Show when={props.total > 0}>
          <span class="chat-details__tally" role="img" aria-label={`${props.title}: ${summary()}`}>
            <For each={SEGMENTS.filter((state) => props.tally[state] > 0)}>
              {(state) => (
                <span
                  class="chat-details__tally-segment"
                  data-state={state}
                  style={{ "flex-grow": props.tally[state] }}
                />
              )}
            </For>
          </span>
        </Show>
      </summary>
      {props.children}
      <Show when={hidden() > 0}>
        <button
          type="button"
          class="chat-details__more"
          aria-expanded={props.expanded ? "true" : "false"}
          onClick={() => props.onExpandedChange(!props.expanded)}
        >
          {props.expanded
            ? t("chat.sessionDetails.showLess")
            : t("chat.sessionDetails.showMore", { count: String(hidden()) })}
        </button>
      </Show>
      <Show when={props.onOpenAll}>
        <button
          type="button"
          class="chat-details__row chat-details__navigation"
          onClick={() => props.onOpenAll?.()}
        >
          <Icon name={props.icon} />
          <span>{props.openAllLabel}</span>
          <Icon name="chevronRight" />
        </button>
      </Show>
    </details>
  );
}

function ProcessRow(props: { row: SessionProcessSummary; onOpen?: () => void }) {
  const status = () => t(`chat.processesPanel.status.${props.row.status}`);
  const lastLine = () => props.row.tail.trimEnd().split("\n").at(-1)?.trim() ?? "";
  const description = () => [props.row.name, status(), lastLine()].filter(Boolean).join(". ");
  const content = () => (
    <>
      <span class="chat-details__process-icon" data-status={props.row.status} aria-hidden="true">
        <Icon name="terminal" />
      </span>
      <span class="chat-details__process-name">{props.row.name}</span>
      <span class="chat-details__process-elapsed" aria-hidden="true">
        <ElapsedTime startMs={props.row.startedAt} endMs={props.row.endedAt ?? null} />
      </span>
      <span class="chat-details__process-tail">{lastLine() || status()}</span>
    </>
  );
  return (
    <div role="listitem" data-process-id={props.row.processId}>
      <Show
        when={props.onOpen}
        fallback={
          <div class="chat-details__process" title={description()}>
            {content()}
          </div>
        }
      >
        <button
          type="button"
          class="chat-details__process"
          title={description()}
          aria-label={description()}
          onClick={() => props.onOpen?.()}
        >
          {content()}
        </button>
      </Show>
    </div>
  );
}

/** The subagents and background processes this session started, as two groups. */
export function ChatDetailsBackground(
  props: Props,
  processes: () => ProcessesPanelData | undefined,
) {
  const [subagentsExpanded, setSubagentsExpanded] = createSignal(false);
  const [processesExpanded, setProcessesExpanded] = createSignal(false);
  const subagents = createMemo(() => attentionOrder(listSubagents(props.details), subagentState));
  const subagentTally = createMemo(() => tally(subagents(), subagentState));
  const processRows = createMemo(() =>
    attentionOrder(processes()?.snapshot.rows ?? [], processState),
  );
  const processTally = createMemo(() => tally(processRows(), processState));
  const visibleProcesses = createMemo(() =>
    processesExpanded() ? processRows() : processRows().slice(0, PREVIEW_ROWS),
  );
  const processError = () => (processRows().length === 0 ? processes()?.snapshot.error : null);
  const openSubagents = () => {
    if (props.presented) {
      props.details.onOpenSubagents?.();
    }
  };
  const openProcesses = () => {
    if (props.presented) {
      props.details.onOpenProcesses?.();
    }
  };
  return (
    <>
      <Show when={subagents().length > 0}>
        <BackgroundGroup
          kind="subagents"
          title={t("chat.sessionDetails.subagents")}
          tally={subagentTally()}
          total={subagents().length}
          icon="bot"
          openAllLabel={t("chat.sessionDetails.allSubagents")}
          onOpenAll={props.details.onOpenSubagents ? openSubagents : undefined}
          expanded={subagentsExpanded()}
          onExpandedChange={setSubagentsExpanded}
        >
          {props.presented && (
            <ChatSubagentActivity
              rows={subagents()}
              limit={subagentsExpanded() ? undefined : PREVIEW_ROWS}
              compact={true}
              onOpenSubagent={props.details.onOpenSubagent}
              onOpenSession={props.details.onSessionSelect}
            />
          )}
        </BackgroundGroup>
      </Show>
      <Show when={processRows().length > 0 || processError()}>
        <BackgroundGroup
          kind="processes"
          title={t("chat.sessionDetails.processes")}
          tally={processTally()}
          total={processRows().length}
          icon="terminal"
          openAllLabel={t("chat.sessionDetails.allProcesses")}
          onOpenAll={props.details.onOpenProcesses ? openProcesses : undefined}
          expanded={processesExpanded()}
          onExpandedChange={setProcessesExpanded}
        >
          <Show when={processError()}>
            <div class="chat-summary__automation-error">
              <span role="status">{t("chat.sessionDetails.processesError")}</span>
              <button
                type="button"
                class="chip chat-summary__automation-retry"
                onClick={() => void processes()?.refresh()}
              >
                {t("common.retry")}
              </button>
            </div>
          </Show>
          <div role="list" aria-label={t("chat.sessionDetails.processes")}>
            <For each={visibleProcesses()} keyed={(row) => row.instanceId}>
              {(row) => (
                <ProcessRow
                  row={row()}
                  onOpen={props.details.onOpenProcesses ? openProcesses : undefined}
                />
              )}
            </For>
          </div>
        </BackgroundGroup>
      </Show>
    </>
  );
}
