import {
  Errored,
  For,
  Loading,
  Show,
  createMemo,
  createSignal,
  createStore,
  isPending,
  latest,
  onSettled,
} from "solid-js";
import type { SessionProcessSummary } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { ElapsedTime } from "../../../components/elapsed-time.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelEmptyState } from "../../../components/solid/panel-empty-state.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { ProcessesPanelData } from "../processes-panel-data.ts";
import { createProcessesPresentation } from "./chat-processes-presentation.ts";
import {
  syncSessionPanelInputs,
  useSessionPanel,
  type SessionPanelProps,
} from "./chat-session-panel.tsx";
import "../../../styles/session-panel-rail.css";
import "./chat-session-panels.css";
import "./chat-processes-panel.css";

export type ChatProcessesPanelProps = SessionPanelProps & {
  mobile: boolean;
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
};
export type ChatProcessesPanel = SolidBridgeElement<ChatProcessesPanelProps>;

export const ChatProcessesPanel = defineSolidBridge<ChatProcessesPanelProps>(
  "openclaw-chat-processes-panel",
  (props, host) => {
    const [finishedOpen, setFinishedOpen] = createSignal(false);
    let list!: HTMLDivElement;

    const listScrollState = useScrollState();
    const panel = useSessionPanel(
      host,
      () => ({ sessionKey: host.sessionKey, agentId: host.agentId, presented: host.presented }),
      ProcessesPanelData,
      (identityChanged) => {
        if (identityChanged) {
          setNavigation((draft) => {
            Object.assign(draft, emptyNavigation());
          });
          if (list) {
            list.scrollTop = 0;
          }
        }
      },
    );
    const presentation = createProcessesPresentation(panel);
    const data = () => panel().snapshot;
    // Full Processes keeps its failed-read empty/loading states; compact Details retains rows.
    const rows = () => (data().readError ? [] : data().rows);
    const visibleError = (loading: boolean) =>
      data().readError ? (loading ? null : data().readError) : data().error;
    // Only local return targets/offsets reset on denied access; output remains with the data owner.
    const emptyNavigation = (): {
      listTop: number;
      selected: string | null;
      returnInstance: string | null;
      openers: Map<string, HTMLButtonElement>;
      outputPositions: Map<string, { left: number; top: number }>;
    } => ({
      listTop: 0,
      selected: null,
      returnInstance: null,
      openers: new Map<string, HTMLButtonElement>(),
      outputPositions: new Map<string, { left: number; top: number }>(),
    });
    const denied = createMemo(() => Boolean(data().error && !rows().length));
    const [navigation, setNavigation] = createStore<ReturnType<typeof emptyNavigation>>((draft) => {
      if (denied()) {
        Object.assign(draft, emptyNavigation());
      }
    }, emptyNavigation());
    // Rendered selection observes denial transitions even while the detail is closed.
    const selected = () => navigation.selected;
    const open = (row: SessionProcessSummary) => {
      setNavigation((draft) => {
        draft.listTop = list.scrollTop;
        draft.returnInstance = row.instanceId;
        draft.selected = row.instanceId;
      });
    };
    const selectedRow = createMemo(() => rows().find((row) => row.instanceId === selected()));
    const running = createMemo(() => rows().filter((row) => row.status === "running"));
    const finished = createMemo(() => rows().filter((row) => row.status !== "running"));
    const status = (row: SessionProcessSummary) =>
      t(
        data().stopping.has(row.instanceId)
          ? "chat.processesPanel.stopping"
          : `chat.processesPanel.status.${row.status}`,
      );
    const elapsed = (row: SessionProcessSummary) =>
      (row.status === "running" || row.endedAt !== undefined) && (
        <ElapsedTime startMs={row.startedAt} endMs={row.endedAt ?? null} />
      );
    const StopButton = (stopProps: { row: SessionProcessSummary; detail?: boolean }) => {
      const stop = presentation.createStop(() => stopProps.row);
      return (
        <Show when={stopProps.row.status === "running" && stopProps.row.canStop}>
          <button
            class={[
              "chat-processes__stop",
              {
                "session-panel-rail__button session-panel-rail__button--labelled":
                  stopProps.detail && !props.mobile,
              },
            ]}
            type="button"
            aria-label={t("chat.processesPanel.stop", { name: stopProps.row.name })}
            title={
              props.mobile ? undefined : t("chat.processesPanel.stop", { name: stopProps.row.name })
            }
            disabled={stop.stopping()}
            onClick={() => void stop.stop()}
          >
            {stopProps.detail && !props.mobile ? (
              <span class="chat-processes__stop-mark" aria-hidden="true" />
            ) : (
              <Icon name="square" />
            )}
            {t(stop.stopping() ? "chat.processesPanel.stopping" : "chat.runControls.stop")}
          </button>
        </Show>
      );
    };
    const error = (loading: boolean, retry: () => void) =>
      visibleError(loading) && (
        <div class="chat-processes__error" role="alert">
          {visibleError(loading)}
          <button class="btn btn--sm" type="button" onClick={() => retry()}>
            {t("common.retry")}
          </button>
        </div>
      );
    const RowName = (nameProps: { name: string }) => {
      const nameScrollState = useScrollState(true, false);
      return (
        <span class="chat-processes__name" ref={nameScrollState}>
          {nameProps.name}
        </span>
      );
    };
    const rowView = (row: () => SessionProcessSummary) => {
      onSettled(() => {
        const id = row().instanceId;
        const initialOpeners = navigation.openers;
        return () => initialOpeners.delete(id);
      });
      return (
        <div
          class="chat-processes__item"
          role="listitem"
          data-process-id={row().processId}
          data-status={row().status}
        >
          <Show
            when={props.mobile}
            fallback={
              <div class="chat-processes__desktop-row">
                <span class="chat-processes__terminal" aria-hidden="true">
                  <Icon name="terminal" />
                  {row().status === "running" && <span class="chat-processes__spinner" />}
                </span>
                <button
                  class="chat-processes__open"
                  type="button"
                  title={row().name}
                  aria-label={row().name}
                  ref={(element) => {
                    navigation.openers.set(row().instanceId, element);
                  }}
                  onClick={() => open(row())}
                >
                  <RowName name={row().name} />
                  {row().status === "running" && (
                    <span class="chat-processes__activity">
                      <span
                        class={{
                          "chat-processes__shimmer": !data().stopping.has(row().instanceId),
                        }}
                      >
                        {data().stopping.has(row().instanceId)
                          ? status(row())
                          : t("chat.processesPanel.runningFor")}
                      </span>{" "}
                      {elapsed(row())}
                    </span>
                  )}
                </button>
                {row().status !== "running" && (
                  <span class="chat-processes__finished-meta">
                    {row().status !== "completed" && (
                      <span class={{ "chat-processes__failure": row().status === "failed" }}>
                        {status(row())}
                      </span>
                    )}
                    {elapsed(row())}
                  </span>
                )}
                <StopButton row={row()} />
                {row().status === "running" && !row().canStop && (
                  <span class="chat-processes__unavailable">
                    {t("chat.processesPanel.cannotStop")}
                  </span>
                )}
                <span class="chat-processes__chevron" aria-hidden="true">
                  <Icon name="chevronRight" />
                </span>
              </div>
            }
          >
            <div class="chat-processes__mobile-row">
              <span class="chat-processes__terminal" role="img" aria-label={status(row())}>
                <Icon name="terminal" />
                {row().status === "running" && <span class="chat-processes__spinner" />}
                {row().status === "completed" && (
                  <Icon class="chat-processes__check" name="check" />
                )}
              </span>
              <button
                class="chat-processes__open"
                type="button"
                aria-label={row().name}
                ref={(element) => {
                  navigation.openers.set(row().instanceId, element);
                }}
                onClick={() => open(row())}
              >
                <RowName name={row().name} />
                <span class="chat-processes__metadata">
                  <span class={{ "chat-processes__failure": row().status === "failed" }}>
                    {status(row())}
                    {row().exitCode != null &&
                      ` · ${t("chat.processesPanel.exitCode", { code: String(row().exitCode) })}`}
                  </span>
                  <span>{elapsed(row())}</span>
                </span>
              </button>
              <StopButton row={row()} />
              <span class="chat-processes__chevron" aria-hidden="true">
                <Icon name="chevronRight" />
              </span>
            </div>
          </Show>
        </div>
      );
    };
    const outputNotes = (row: SessionProcessSummary) => (
      <>
        <p class="chat-processes__note">{t("chat.processesPanel.retention")}</p>
        {row.truncated && (
          <p class="chat-processes__note">{t("chat.processesPanel.outputTruncated")}</p>
        )}
      </>
    );
    const Detail = (detailProps: { loading: boolean; retry: () => void }) => {
      let output!: HTMLDivElement;
      let back!: HTMLButtonElement;
      const titleScrollState = useScrollState(true, false);
      const savePosition = () => {
        const id = selected();
        if (id && output) {
          navigation.outputPositions.set(id, { left: output.scrollLeft, top: output.scrollTop });
        }
      };
      onSettled(() => {
        back.focus({ preventScroll: true });
      });
      const Output = (outputProps: { row: SessionProcessSummary }) => {
        const scrollState = useScrollState();
        onSettled(() => {
          const position = navigation.outputPositions.get(outputProps.row.instanceId);
          if (position) {
            output.scrollLeft = position.left;
            output.scrollTop = position.top;
          }
        });
        return (
          <div
            class="chat-processes__output"
            tabindex={0}
            aria-label={t("chat.processesPanel.output")}
            ref={[
              (element) => {
                output = element;
                scrollState(element);
              },
              elementRef(props.onScrollPortRef),
            ]}
            onScroll={savePosition}
          >
            {props.mobile && <h3>{t("chat.processesPanel.output")}</h3>}
            <Show
              when={outputProps.row.tail || props.mobile}
              fallback={
                <div class="chat-processes__output-empty">
                  <PanelEmptyState
                    presentation="desktop"
                    icon={<Icon name="terminal" />}
                    heading={t("chat.processesPanel.noOutputTitle")}
                    description={t("chat.processesPanel.noOutput")}
                  />
                </div>
              }
            >
              <pre>{outputProps.row.tail || t("chat.processesPanel.noOutput")}</pre>
            </Show>
            {!props.mobile && outputNotes(outputProps.row)}
          </div>
        );
      };
      return (
        <div class="chat-processes__detail">
          <header
            class={["chat-processes__detail-header", { "session-panel-rail": !props.mobile }]}
            data-presentation={props.mobile ? undefined : "desktop"}
          >
            <span
              class={[
                "chat-processes__rail-control",
                { "session-panel-rail__group": !props.mobile },
              ]}
            >
              <button
                class={["chat-processes__back", { "session-panel-rail__button": !props.mobile }]}
                type="button"
                ref={(element) => {
                  back = element;
                }}
                aria-label={t("chat.processesPanel.back")}
                title={props.mobile ? undefined : t("chat.processesPanel.back")}
                onClick={() => {
                  savePosition();
                  setNavigation((draft) => {
                    draft.selected = null;
                  });
                  onSettled(() => {
                    list.scrollTop = navigation.listTop;
                    const opener = navigation.returnInstance
                      ? navigation.openers.get(navigation.returnInstance)
                      : undefined;
                    (opener?.isConnected ? opener : list).focus({ preventScroll: true });
                    setNavigation((draft) => {
                      draft.returnInstance = null;
                    });
                  });
                }}
              >
                <Icon name="chevronLeft" />
              </button>
            </span>
            <strong
              class="chat-processes__detail-name"
              ref={titleScrollState}
              title={props.mobile ? undefined : selectedRow()?.name}
            >
              {selectedRow()?.name}
            </strong>
            <Show when={selectedRow()}>
              {(row) => (
                <>
                  {row().status === "running" && row().canStop && (
                    <span
                      class={[
                        "chat-processes__rail-control",
                        { "session-panel-rail__group": !props.mobile },
                      ]}
                    >
                      <StopButton row={row()} detail />
                    </span>
                  )}
                  {!props.mobile && row().status === "running" && !row().canStop && (
                    <span class="chat-processes__unavailable">
                      {t("chat.processesPanel.cannotStop")}
                    </span>
                  )}
                </>
              )}
            </Show>
          </header>
          {error(detailProps.loading, detailProps.retry)}
          <Show
            when={selectedRow()}
            fallback={
              <Show
                when={detailProps.loading}
                fallback={
                  <div class="chat-processes__empty" role="status">
                    {t(
                      data().hasResult
                        ? data().truncated
                          ? "chat.processesPanel.omitted"
                          : "chat.processesPanel.expired"
                        : "chat.processesPanel.disconnected",
                    )}
                  </div>
                }
              >
                <PanelLoadingSkeleton variant="terminal" label={t("common.loading")} compact />
              </Show>
            }
          >
            {(row) => (
              <>
                <div class="chat-processes__output-info">
                  {props.mobile && <strong class="chat-processes__identity">{row().name}</strong>}
                  <div class="chat-processes__metadata" data-status={row().status}>
                    <span class="chat-processes__status">{status(row())}</span>
                    <span>{elapsed(row())}</span>
                    {row().exitCode != null && (
                      <span>
                        {t("chat.processesPanel.exitCode", { code: String(row().exitCode) })}
                      </span>
                    )}
                  </div>
                  {row().exitReason && <p class="chat-processes__note">{row().exitReason}</p>}
                </div>
                <Output row={row()} />
                {props.mobile && (
                  <footer class="chat-processes__output-notice">{outputNotes(row())}</footer>
                )}
              </>
            )}
          </Show>
        </div>
      );
    };
    const Content = (contentProps: { loading: boolean; retry: () => void }) => (
      <div class="chat-processes__panel" data-mobile={props.mobile ? "true" : "false"}>
        <div
          class="chat-processes__list"
          hidden={Boolean(selected())}
          tabindex={-1}
          aria-busy={contentProps.loading ? "true" : "false"}
          ref={[
            (element) => {
              list = element;
              listScrollState(element);
            },
            elementRef(props.onScrollPortRef),
          ]}
        >
          {error(contentProps.loading, contentProps.retry)}
          <Show
            when={rows().length}
            fallback={
              <Show
                when={data().hasResult && !data().error && !contentProps.loading}
                fallback={
                  <Show
                    when={contentProps.loading}
                    fallback={
                      <div class="chat-processes__empty" role="status">
                        {!visibleError(contentProps.loading)
                          ? t("chat.processesPanel.disconnected")
                          : null}
                      </div>
                    }
                  >
                    <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} />
                  </Show>
                }
              >
                <PanelEmptyState
                  presentation={props.mobile ? "mobile" : "desktop"}
                  icon={<Icon name="terminal" />}
                  heading={t("chat.processesPanel.emptyTitle")}
                  description={t("chat.processesPanel.empty")}
                />
              </Show>
            }
          >
            <section class="chat-processes__running">
              <h3>
                <span>{t("chat.processesPanel.runningDesktop", { count: "" }).trim()}</span>
                <span class="chat-processes__count">{running().length}</span>
              </h3>
              <div role="list">
                <For each={running()} keyed={(row) => row.instanceId}>
                  {rowView}
                </For>
              </div>
              {!running().length && (
                <div class="chat-processes__empty">{t("chat.processesPanel.noRunning")}</div>
              )}
            </section>
            <section class="chat-processes__finished">
              <button
                class="chat-processes__finished-toggle"
                type="button"
                aria-expanded={finishedOpen() ? "true" : "false"}
                onClick={() => setFinishedOpen((value) => !value)}
              >
                <span>{t("chat.processesPanel.finishedDesktop", { count: "" }).trim()}</span>
                <span class="chat-processes__count">{finished().length}</span>
                <Icon name={finishedOpen() ? "chevronDown" : "chevronRight"} />
              </button>
              <div role="list" hidden={!finishedOpen()}>
                {finishedOpen() && (
                  <For each={finished()} keyed={(row) => row.instanceId}>
                    {rowView}
                  </For>
                )}
              </div>
            </section>
          </Show>
          {data().truncated && (
            <p class="chat-processes__note">{t("chat.processesPanel.listTruncated")}</p>
          )}
        </div>
        <Show when={selected()}>
          <Detail loading={contentProps.loading} retry={contentProps.retry} />
        </Show>
      </div>
    );
    const retry = () => void panel().refresh();
    // Read fallbacks must not replace the retained content's navigation refs.
    const ReadFallback = (fallbackProps: { loading: boolean; retry: () => void }) => (
      <div class="chat-processes__panel" data-mobile={props.mobile ? "true" : "false"}>
        <div class="chat-processes__list" aria-busy={fallbackProps.loading ? "true" : "false"}>
          {error(fallbackProps.loading, fallbackProps.retry)}
          <Show when={fallbackProps.loading}>
            <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} />
          </Show>
        </div>
      </div>
    );
    return (
      <Errored
        fallback={(_error, reset) => (
          <ReadFallback
            loading={isPending(presentation.read)}
            retry={() => {
              retry();
              reset();
            }}
          />
        )}
      >
        <Loading on={presentation.scope()} fallback={<ReadFallback loading retry={retry} />}>
          {(latest(presentation.read), null)}
          <Content loading={isPending(presentation.read)} retry={retry} />
        </Loading>
      </Errored>
    );
  },
  {
    propertyChanged: syncSessionPanelInputs,
    properties: {
      sessionKey: { default: "", attribute: false },
      agentId: { default: "main", attribute: false },
      presented: { default: true, type: Boolean },
      mobile: { default: false, type: Boolean },
      onScrollPortRef: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-processes-panel": ChatProcessesPanel;
  }
}
