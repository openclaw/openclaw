import type { JSX } from "@solidjs/web";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onSettled,
} from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import { isSessionRunStateActive } from "../../../lib/session-run-state.ts";
import { endedWithoutFinishing, isUnfinishedSubagent } from "../chat-spawned-subagent.ts";
import type { SubagentsPanelRow } from "../subagents-panel-data.ts";
import "../../../styles/session-panel-rail.css";
import "./chat-subagents-working.css";
import "./chat-subagents-panel-desktop.css";

type Group = "active" | "waiting" | "done" | "stopped" | "failed";
const groups: readonly Group[] = ["active", "waiting", "done", "stopped", "failed"];

function groupLabel(group: Group) {
  return t(
    group === "stopped"
      ? "chat.sessionDetails.stopped"
      : group === "failed"
        ? "common.failed"
        : `chat.subagentsPanel.desktopFilter.${group}`,
  );
}

export type ChatSubagentsPanelDesktopProps = {
  sessionKey: string;
  agentId: string;
  rows: readonly SubagentsPanelRow[];
  loading: boolean;
  error: string | null;
  hasResult: boolean;
  active: boolean;
  /** Whether Show more has revealed the complete Done list, not its disclosure. */
  doneExpanded?: boolean;
  onDoneExpandedChange?: (expanded: boolean) => void;
  onRefresh: () => void;
  onStop: (row: SubagentsPanelRow) => void;
  onOpen: (row: SubagentsPanelRow) => void;
  renderElapsed: (row: SubagentsPanelRow) => JSX.Element;
};

function groupFor(row: SubagentsPanelRow): Group {
  if (row.session.status === "queued") {
    return "waiting";
  }
  return isSessionRunStateActive(row.session)
    ? "active"
    : isUnfinishedSubagent(row.session)
      ? "waiting"
      : (endedWithoutFinishing(row.session) ?? "done");
}

export function SubagentDesktopAvatar(props: { sessionKey: string; working?: boolean }) {
  return (
    <span
      class="subagents-desktop__avatar"
      style={{ "--subagent-hue": fnv1aUtf16(props.sessionKey) % 360 }}
      aria-hidden="true"
    >
      <Icon name="bot" />
      <Show when={props.working}>
        <span class="subagents-desktop__spinner" />
      </Show>
    </span>
  );
}

function DesktopRow(props: {
  row: SubagentsPanelRow;
  onOpen: (row: SubagentsPanelRow, source: HTMLButtonElement) => void;
  onStop: (row: SubagentsPanelRow) => void;
  renderElapsed: ChatSubagentsPanelDesktopProps["renderElapsed"];
}) {
  const name = () => resolveSessionDisplayName(props.row.session.key, props.row.session);
  const group = () => groupFor(props.row);
  const ended = () => endedWithoutFinishing(props.row.session);
  const metadata = () =>
    [
      props.row.callCount &&
        t(
          !props.row.callCount.exact
            ? "chat.subagentsPanel.callsAtLeast"
            : props.row.callCount.count === 1
              ? "chat.subagentsPanel.callsOne"
              : "chat.subagentsPanel.callsMany",
          { count: String(props.row.callCount.count) },
        ),
      props.row.activity || props.row.toolDisplayName,
      ended() && t(ended() === "failed" ? "common.failed" : "chat.sessionDetails.stopped"),
    ]
      .filter(Boolean)
      .join(" · ");
  const stopLabel = () =>
    props.row.stopping
      ? t("chat.subagentsPanel.stopping")
      : t("chat.subagentsPanel.stop", { name: name() });
  return (
    <div
      class="subagents-desktop__row"
      data-session-key={props.row.session.key}
      data-group={group()}
      role="listitem"
    >
      <button
        class="subagents-desktop__open"
        type="button"
        title={[name(), metadata()].filter(Boolean).join("\n")}
        onClick={(event) => props.onOpen(props.row, event.currentTarget)}
      >
        <SubagentDesktopAvatar sessionKey={props.row.session.key} working={group() === "active"} />
        <span class="subagents-desktop__identity">
          <span class="subagents-desktop__name">{name()}</span>
          <Show when={group() !== "done"}>
            <span class="subagents-desktop__status">
              <Show
                when={group() === "active"}
                fallback={
                  group() === "waiting"
                    ? props.row.session.status === "queued"
                      ? t("common.queued")
                      : t("chat.subagentsPanel.desktopWaiting")
                    : groupLabel(group())
                }
              >
                <span class="subagents-desktop__working">
                  {t("chat.subagentsPanel.desktopWorking")}
                </span>{" "}
                <Show
                  when={props.row.session.runtimeMs != null || props.row.session.startedAt != null}
                >
                  <span>
                    {t("chat.subagentsPanel.desktopFor")} {props.renderElapsed(props.row)}
                  </span>
                </Show>
              </Show>
            </span>
          </Show>
          <span class="sr-only">{metadata()}</span>
        </span>
        <Show when={group() !== "active"}>
          <span class="subagents-desktop__elapsed" title={t("chat.subagentsPanel.duration")}>
            {props.renderElapsed(props.row)}
          </span>
        </Show>
        <Icon class="subagents-desktop__chevron" name="chevronRight" />
      </button>
      <Show
        when={
          isSessionRunStateActive(props.row.session) && props.row.session.activeRunIds?.length === 1
        }
      >
        <button
          class="subagents-desktop__stop"
          type="button"
          aria-label={stopLabel()}
          title={props.row.stopAccess.allowed ? stopLabel() : props.row.stopAccess.reason}
          disabled={props.row.stopping || !props.row.canStop}
          onClick={() => props.onStop(props.row)}
        >
          <Icon name="stop" />
          <span>
            {props.row.stopping ? t("chat.subagentsPanel.stopping") : t("chat.runControls.stop")}
          </span>
        </button>
      </Show>
    </div>
  );
}

/** Retained by the panel owner while a child is open; execution remains in SubagentsPanelData. */
export function ChatSubagentsPanelDesktop(props: ChatSubagentsPanelDesktopProps) {
  const id = createUniqueId();
  const [doneOpen, setDoneOpen] = createSignal(true);
  const [showAllDone, setShowAllDone] = createSignal(false);
  let content!: HTMLDivElement;
  let returnFocus: HTMLButtonElement | undefined;
  let returnScroll = 0;
  createEffect(
    () => [props.sessionKey, props.agentId] as const,
    () => {
      setDoneOpen(true);
      setShowAllDone(false);
      returnFocus = undefined;
      returnScroll = 0;
    },
  );
  createEffect(
    () => props.active,
    (active) => {
      if (active && returnFocus) {
        content.scrollTop = returnScroll;
        // A child may disappear while open; retain a focus destination in the list.
        (returnFocus.isConnected ? returnFocus : content).focus({ preventScroll: true });
        returnFocus = undefined;
      }
    },
  );
  const allDone = () => props.doneExpanded ?? showAllDone();
  const visible = (group: Group) => props.rows.filter((row) => groupFor(row) === group);
  const shownGroups = createMemo(() => groups.filter((group) => visible(group).length > 0));
  const open = (row: SubagentsPanelRow, source: HTMLButtonElement) => {
    returnFocus = source;
    returnScroll = content.scrollTop;
    props.onOpen(row);
  };
  return (
    <div
      class="subagents-desktop"
      hidden={!props.active}
      aria-busy={props.loading ? "true" : "false"}
    >
      <div
        ref={(element) => {
          content = element;
        }}
        class="subagents-desktop__content"
        tabindex="-1"
      >
        <Show when={props.error}>
          <div class="chat-subagents__error" role="alert">
            <span>{props.error}</span>
            <button class="btn btn--sm" type="button" onClick={() => props.onRefresh()}>
              {t("common.retry")}
            </button>
          </div>
        </Show>
        <Show
          when={props.rows.length}
          fallback={
            (props.loading || (props.hasResult && !props.error)) && (
              <div class="chat-subagents__empty" role="status">
                {t(props.loading ? "common.loading" : "chat.subagentsPanel.empty")}
              </div>
            )
          }
        >
          <For each={shownGroups()} keyed={(group) => group}>
            {(group) => (
              <section class="subagents-desktop__group" aria-label={groupLabel(group())}>
                <Show
                  when={group() === "done"}
                  fallback={
                    <h3 class="subagents-desktop__heading">
                      <span>{groupLabel(group())}</span>
                      <span class="subagents-desktop__count">{visible(group()).length}</span>
                    </h3>
                  }
                >
                  <button
                    class="subagents-desktop__heading subagents-desktop__disclosure"
                    type="button"
                    aria-expanded={doneOpen() ? "true" : "false"}
                    aria-controls={`${id}-done`}
                    onClick={() => setDoneOpen((value) => !value)}
                  >
                    <span>{t("chat.subagentsPanel.desktopFilter.done")}</span>
                    <span class="subagents-desktop__count">{visible("done").length}</span>
                    <Icon name={doneOpen() ? "chevronDown" : "chevronRight"} />
                  </button>
                </Show>
                <Show when={group() !== "done" || doneOpen()}>
                  <div id={group() === "done" ? `${id}-done` : undefined} role="list">
                    <For
                      each={
                        group() === "done" && !allDone()
                          ? visible("done").slice(0, 10)
                          : visible(group())
                      }
                      keyed={(row) => row.session.key}
                    >
                      {(row) => (
                        <DesktopRow
                          row={row()}
                          onOpen={open}
                          onStop={props.onStop}
                          renderElapsed={props.renderElapsed}
                        />
                      )}
                    </For>
                  </div>
                  <Show when={group() === "done" && !allDone() && visible("done").length > 10}>
                    <button
                      class="subagents-desktop__more"
                      type="button"
                      onClick={() => {
                        setShowAllDone(true);
                        props.onDoneExpandedChange?.(true);
                        onSettled(() =>
                          content
                            .querySelectorAll<HTMLButtonElement>(
                              '[data-group="done"] .subagents-desktop__open',
                            )[10]
                            ?.focus({ preventScroll: true }),
                        );
                      }}
                    >
                      {t("chat.subagentsPanel.desktopShowMore")}
                    </button>
                  </Show>
                </Show>
              </section>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
