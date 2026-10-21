import { For, Show, createMemo } from "solid-js";
import type { SessionProcessSummary } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ProcessesPanelData } from "../processes-panel-data.ts";
import { ChatDetailsDesktopSection } from "./chat-details-desktop-section.tsx";
import "./chat-details-processes.css";

type Props = {
  /** Read the native host's projection; it owns observation, refresh and stop authority. */
  processes: () => ProcessesPanelData | undefined;
  presented: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onOpen?: () => void;
};

const order = { running: 0, failed: 1, killed: 2, completed: 3 } as const;

function ProcessRow(props: {
  row: SessionProcessSummary;
  stopping: boolean;
  presented: boolean;
  onOpen: () => void;
  onStop: (row: SessionProcessSummary) => void;
}) {
  const nameOverflow = useScrollState(true, false, { revision: () => props.row.name });
  const status = () =>
    t(
      props.stopping
        ? "chat.processesPanel.stopping"
        : `chat.processesPanel.status.${props.row.status}`,
    );
  const description = () => `${props.row.name}. ${status()}`;
  return (
    <div
      class="chat-details-processes__row"
      role="listitem"
      data-process-id={props.row.processId}
      data-status={props.row.status}
      data-stoppable={props.row.status === "running" && props.row.canStop ? "" : undefined}
      data-stopping={props.stopping ? "" : undefined}
    >
      <button
        class="chat-details-processes__open"
        type="button"
        title={description()}
        aria-label={description()}
        disabled={!props.presented}
        onClick={() => props.onOpen()}
      >
        <span class="chat-details-processes__icon" aria-hidden="true">
          <Icon name="squareTerminal" />
          <span class="chat-details-processes__badge" data-status={props.row.status}>
            <Show
              when={props.row.status === "running"}
              fallback={
                <Icon
                  name={
                    props.row.status === "completed"
                      ? "check"
                      : props.row.status === "failed"
                        ? "x"
                        : "square"
                  }
                />
              }
            >
              <span class="chat-details-processes__spinner" />
            </Show>
          </span>
        </span>
        <span class="chat-details-processes__name" ref={nameOverflow}>
          {props.row.name}
        </span>
      </button>
      <Show when={props.row.status === "running" && props.row.canStop}>
        <button
          class="chat-details-processes__stop"
          type="button"
          title={
            props.stopping ? status() : t("chat.processesPanel.stop", { name: props.row.name })
          }
          aria-label={t("chat.processesPanel.stop", { name: props.row.name })}
          disabled={!props.presented || props.stopping}
          onClick={() => props.onStop(props.row)}
        >
          <Show when={props.stopping} fallback={<Icon name="stop" />}>
            <span class="chat-details-processes__spinner" />
          </Show>
        </button>
      </Show>
      <Show when={props.stopping}>
        <span class="sr-only" role="status">
          {status()}
        </span>
      </Show>
    </div>
  );
}

/** Desktop list using the same process snapshot and operations as the full panel. */
export function ChatDetailsProcesses(props: Props) {
  const snapshot = () => props.processes()?.snapshot;
  const rows = createMemo(() =>
    (snapshot()?.rows ?? []).toSorted((a, b) => order[a.status] - order[b.status]),
  );
  const open = () => {
    if (props.presented) {
      props.onOpen?.();
    }
  };
  const stop = (row: SessionProcessSummary) => {
    if (props.presented) {
      void props.processes()?.stop(row);
    }
  };
  return (
    <Show when={props.onOpen}>
      <ChatDetailsDesktopSection
        section="processes"
        title={t("chat.sessionDetails.processes")}
        expanded={props.expanded}
        presented={props.presented}
        onExpandedChange={(expanded) => props.onExpandedChange(expanded)}
      >
        <div class="chat-details-processes" aria-busy={snapshot()?.loading ? "true" : "false"}>
          <Show when={snapshot()?.error}>
            {(error) => (
              <div class="chat-details-processes__error" role="alert">
                <span>{error()}</span>
                <button
                  class="chip"
                  type="button"
                  disabled={!props.presented || snapshot()?.loading}
                  onClick={() => void props.processes()?.refresh()}
                >
                  {t("common.retry")}
                </button>
              </div>
            )}
          </Show>
          <Show
            when={rows().length > 0}
            fallback={
              <Show
                when={snapshot()?.loading}
                fallback={
                  <Show when={!snapshot()?.error}>
                    <div class="chat-details__muted" role="status">
                      {t(
                        snapshot()?.hasResult
                          ? "chat.processesPanel.empty"
                          : "chat.processesPanel.disconnected",
                      )}
                    </div>
                  </Show>
                }
              >
                <PanelLoadingSkeleton
                  compact
                  variant="file-list"
                  label={t("chat.sessionDetails.processes")}
                />
              </Show>
            }
          >
            <div
              class="chat-details-processes__list"
              role="list"
              aria-label={t("chat.sessionDetails.processes")}
            >
              <For each={rows()} keyed={(row) => row.instanceId}>
                {(row) => (
                  <ProcessRow
                    row={row()}
                    stopping={snapshot()?.stopping.has(row().instanceId) ?? false}
                    presented={props.presented}
                    onOpen={open}
                    onStop={stop}
                  />
                )}
              </For>
            </div>
          </Show>
          <Show when={snapshot()?.truncated}>
            <div class="chat-details__muted">{t("chat.processesPanel.listTruncated")}</div>
          </Show>
        </div>
      </ChatDetailsDesktopSection>
    </Show>
  );
}
