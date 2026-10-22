import type { JSX } from "@solidjs/web";
import { Errored, Loading, Show, createMemo, createSignal, isPending, latest } from "solid-js";
import type { ChatInputRegion } from "../../../app/chat-input-owner.ts";
import { ElapsedTime } from "../../../components/elapsed-time.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createPendingFocus } from "../../../lib/reactive/pending-focus.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import { isSessionRunStateActive } from "../../../lib/session-run-state.ts";
import { parseAgentSessionKey } from "../../../lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import type { PaneSessionChangeOptions } from "../chat-pane-shared.ts";
import { endedWithoutFinishing, isUnfinishedSubagent } from "../chat-spawned-subagent.ts";
import { SubagentsPanelData, type SubagentsPanelRow } from "../subagents-panel-data.ts";
import {
  SessionPanelGroups,
  syncSessionPanelInputs,
  useSessionPanel,
  type SessionPanelProps,
} from "./chat-session-panel.tsx";
import { ChatSubagentsMobileList, type ChatSubagentMobileItem } from "./chat-subagents-mobile.tsx";
import "./chat-session-panels.css";
import "./chat-subagents-panel.css";
import { ChatSubagentsPanelDesktop } from "./chat-subagents-panel-desktop.tsx";
import { createSubagentsPresentation } from "./chat-subagents-presentation.ts";

registerEnglishCatalog(registerChatSessionEnglish);

type Props = SessionPanelProps & {
  paneId: string;
  presentationId: string;
  inputRegion: ChatInputRegion;
  /** Resolved by the native chrome owner, never inferred from the panel width. */
  mobile?: boolean;
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
  /** Optional persisted UI preference supplied by the session layout owner. */
  doneExpanded?: boolean;
  onDoneExpandedChange?: (expanded: boolean) => void;
  showRequest?: () => string | null | undefined;
  onSessionSelect?: (sessionKey: string, options?: PaneSessionChangeOptions) => boolean | void;
};
export type ChatSubagentsPanel = SolidBridgeElement<Props>;
let panelSequence = 0;

export const ChatSubagentsPanel = defineSolidBridge<Props>(
  "openclaw-chat-subagents-panel",
  (props, host) => {
    const [finishedOpen, setFinishedOpen] = createSignal(true);
    const finishedId = `chat-subagents-finished-${++panelSequence}`;
    let mobileList: HTMLDivElement | undefined;
    let mobileFirstButton: (() => HTMLButtonElement | undefined) | undefined;
    let mobileRetry: HTMLButtonElement | undefined;
    let mobileReturn: { scrollTop: number; focus: HTMLElement | null } | undefined;
    const data = useSessionPanel(
      host,
      () => ({ sessionKey: host.sessionKey, agentId: host.agentId, presented: host.presented }),
      SubagentsPanelData,
      syncSelection,
    );
    const readiness = createSubagentsPresentation(data);
    const createMobileStop = (key: () => string) =>
      readiness.createStop(() => data().rows.find((row) => row.session.key === key()));
    const consumeRead = () => {
      latest(readiness.read);
      return null;
    };
    const FallbackShell = (fallbackProps: { loading?: boolean; children: JSX.Element }) => (
      <div
        class={
          props.mobile === true
            ? "chat-subagents-mobile"
            : props.mobile === false
              ? "subagents-desktop"
              : "chat-subagents__list"
        }
        hidden={Boolean(selected()) || !props.presented}
        aria-busy={fallbackProps.loading ? "true" : "false"}
      >
        <Show when={props.mobile === false} fallback={fallbackProps.children}>
          <div class="subagents-desktop__content" tabindex="-1">
            {fallbackProps.children}
          </div>
        </Show>
      </div>
    );
    const ReadBoundary = (readProps: { children: JSX.Element }) => (
      <Errored
        fallback={(error, reset) => (
          <FallbackShell>
            <div class="chat-subagents__error" role="alert">
              <span>{formatUiError(error())}</span>
              <button
                ref={(button) => {
                  mobileRetry = button;
                }}
                class="btn btn--sm"
                type="button"
                onClick={() => {
                  void data().refresh();
                  reset();
                }}
              >
                {t("common.retry")}
              </button>
            </div>
          </FallbackShell>
        )}
      >
        <Loading
          on={readiness.scope().retired}
          fallback={
            <FallbackShell loading>
              <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} compact />
            </FallbackShell>
          }
        >
          {consumeRead()}
          {readProps.children}
        </Loading>
      </Errored>
    );
    const Empty = () => (
      <Show
        when={isPending(readiness.read)}
        fallback={
          data().hasResult &&
          !data().stopError && (
            <div class="chat-subagents__empty" role="status">
              {t("chat.subagentsPanel.empty")}
            </div>
          )
        }
      >
        <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} compact />
      </Show>
    );
    // An applied request must not reopen detail after the user returns to the list.
    let appliedRequest: Props["showRequest"];
    // Keep a local choice until the authoritative roster removes it or denies access.
    const [selected, setSelected] = createSignal<{ key: string; agentId: string } | null>(
      (previous) => {
        const owner = data();
        return previous &&
          !owner.loading &&
          ((owner.error && !owner.rows.length) ||
            (owner.hasResult &&
              !owner.error &&
              !owner.rows.some((row) => row.session.key === previous.key)))
          ? null
          : (previous ?? null);
      },
    );
    const subagentAgentId = (key: string) =>
      data().rows.find((row) => row.session.key === key)?.session.agentId ??
      parseAgentSessionKey(key)?.agentId ??
      host.agentId;
    function syncSelection(identityChanged: boolean): void {
      if (identityChanged) {
        setSelected(null);
        setFinishedOpen(true);
        mobileReturn = undefined;
        if (mobileList) {
          mobileList.scrollTop = 0;
        }
      }
      const request = host.showRequest;
      if (request !== appliedRequest) {
        appliedRequest = request;
        const key = request?.();
        if (key !== undefined) {
          setSelected(key ? { key, agentId: subagentAgentId(key) } : null);
        }
      }
    }
    createPendingFocus(
      () => ({
        active: props.mobile === true && !selected() && props.presented,
        request: mobileReturn,
      }),
      {
        requested: (next) => Boolean(next.request),
        ready: (next) => next.active && Boolean(mobileList),
        focus: ({ request }) => {
          if (mobileList && request) {
            mobileList.scrollTop = request.scrollTop;
            const target = request.focus;
            (target?.isConnected && mobileList.contains(target)
              ? target
              : mobileRetry?.isConnected
                ? mobileRetry
                : mobileFirstButton?.()
            )?.focus({ preventScroll: true });
            mobileReturn = undefined;
          }
        },
      },
    );
    const unfinished = (row: SubagentsPanelRow) =>
      row.session.status === "queued" || isUnfinishedSubagent(row.session);
    const running = createMemo(() => data().rows.filter(unfinished));
    const finished = createMemo(() => data().rows.filter((row) => !unfinished(row)));
    const detailId = () =>
      selected() ? `${props.presentationId}:subagent:${selected()!.key}` : undefined;
    const renderElapsed = (row: SubagentsPanelRow) => {
      const session = row.session;
      const active = isSessionRunStateActive(session);
      if (session.runtimeMs != null) {
        return active && session.runtimeSampledAt != null ? (
          <ElapsedTime
            startMs={session.runtimeSampledAt - session.runtimeMs}
            includeSeconds={props.mobile === true}
          />
        ) : (
          formatDurationCompact(session.runtimeMs, { includeSeconds: props.mobile === true })
        );
      }
      return (
        session.startedAt != null &&
        (active || session.endedAt != null) && (
          <ElapsedTime
            includeSeconds={props.mobile === true}
            startMs={session.startedAt}
            endMs={active ? null : session.endedAt}
          />
        )
      );
    };
    const mobileItem = (row: SubagentsPanelRow): ChatSubagentMobileItem => {
      const owner = data();
      const active = isSessionRunStateActive(row.session);
      const status =
        row.session.status === "queued"
          ? "queued"
          : active
            ? "running"
            : isUnfinishedSubagent(row.session)
              ? "waiting"
              : (endedWithoutFinishing(row.session) ?? "finished");
      const title = resolveSessionDisplayName(row.session.key, row.session);
      const statusLabel =
        status === "queued"
          ? t("common.queued")
          : status === "running"
            ? t("common.running")
            : status === "waiting"
              ? t("chat.waitingOnSubagents")
              : status === "failed"
                ? t("common.failed")
                : status === "stopped"
                  ? t("chat.sessionDetails.stopped")
                  : t("common.completed");
      return {
        key: row.session.key,
        title,
        status,
        statusLabel,
        activity:
          status === "queued" || status === "waiting"
            ? statusLabel
            : active
              ? row.activity || row.toolDisplayName
              : undefined,
        calls:
          row.callCount === undefined
            ? undefined
            : t(
                !row.callCount.exact
                  ? "chat.subagentsPanel.callsAtLeast"
                  : row.callCount.count === 1
                    ? "chat.subagentsPanel.callsOne"
                    : "chat.subagentsPanel.callsMany",
                { count: String(row.callCount.count) },
              ),
        elapsed: renderElapsed(row),
        elapsedLabel: t(active ? "chat.subagentsPanel.elapsed" : "chat.subagentsPanel.duration"),
        stop:
          active && row.session.activeRunIds?.length === 1
            ? {
                label: t(row.stopping ? "chat.subagentsPanel.stopping" : "chat.runControls.stop"),
                accessibleLabel: row.stopping
                  ? t("chat.subagentsPanel.stopping")
                  : t("chat.subagentsPanel.stop", { name: title }),
                disabled: !row.canStop,
                pending: row.stopping,
                disabledReason: row.stopAccess.allowed ? undefined : row.stopAccess.reason,
                confirmation: {
                  title: t("chat.subagentsPanel.stopConfirmTitle"),
                  message: t("chat.subagentsPanel.stopConfirmMessage"),
                  confirmLabel: t("chat.subagentsPanel.stopConfirmAction"),
                  cancelLabel: t("common.cancel"),
                },
                // Capture this row/run and owner before the asynchronous confirmation.
                onConfirm: () => owner.stop(row),
              }
            : undefined,
      };
    };
    const mobileRunning = createMemo(() =>
      props.mobile === true ? running().map(mobileItem) : [],
    );
    const mobileFinished = createMemo(() =>
      props.mobile === true ? finished().map(mobileItem) : [],
    );
    return (
      <>
        <Show when={props.mobile === true}>
          <div style={{ display: !selected() && props.presented ? "contents" : "none" }}>
            <ReadBoundary>
              <ChatSubagentsMobileList
                createStop={createMobileStop}
                running={mobileRunning()}
                finished={mobileFinished()}
                runningLabel={t("common.running")}
                finishedLabel={t("chat.subagentsPanel.mobileFinished")}
                noRunningLabel={t("chat.subagentsPanel.noRunning")}
                finishedId={finishedId}
                finishedOpen={finishedOpen()}
                onToggleFinished={() => setFinishedOpen((value) => !value)}
                loading={isPending(readiness.read)}
                onScrollPortRef={props.onScrollPortRef}
                listRef={(element, firstButton) => {
                  mobileList = element;
                  mobileFirstButton = firstButton;
                }}
                onOpen={(key) => {
                  const focus = mobileList?.ownerDocument.activeElement;
                  mobileReturn = {
                    scrollTop: mobileList?.scrollTop ?? 0,
                    focus: focus instanceof HTMLElement ? focus : null,
                  };
                  setSelected({ key, agentId: subagentAgentId(key) });
                }}
                notice={
                  data().stopError && (
                    <div class="chat-subagents__error" role="alert">
                      <span>{data().stopError}</span>
                      <button
                        ref={(button) => {
                          mobileRetry = button;
                        }}
                        class="btn btn--sm"
                        type="button"
                        onClick={() => void data().refresh()}
                      >
                        {t("common.retry")}
                      </button>
                    </div>
                  )
                }
                empty={<Empty />}
              />
            </ReadBoundary>
          </div>
        </Show>
        <Show when={props.mobile === false}>
          <ReadBoundary>
            <ChatSubagentsPanelDesktop
              sessionKey={props.sessionKey}
              agentId={props.agentId}
              rows={data().rows}
              loading={isPending(readiness.read)}
              error={data().stopError}
              hasResult={data().hasResult}
              active={!selected() && props.presented}
              doneExpanded={props.doneExpanded}
              onDoneExpandedChange={props.onDoneExpandedChange}
              onRefresh={() => void data().refresh()}
              createStop={readiness.createStop}
              onOpen={(row) =>
                setSelected({ key: row.session.key, agentId: subagentAgentId(row.session.key) })
              }
              renderElapsed={renderElapsed}
            />
          </ReadBoundary>
        </Show>
        <Show
          when={detailId()}
          keyed
          fallback={
            <Show when={props.mobile === undefined}>
              <ReadBoundary>
                <div
                  class="chat-subagents__list"
                  aria-busy={isPending(readiness.read) ? "true" : "false"}
                >
                  {data().stopError && (
                    <div class="chat-subagents__error" role="alert">
                      <span>{data().stopError}</span>
                      <button
                        class="btn btn--sm"
                        type="button"
                        onClick={() => void data().refresh()}
                      >
                        {t("common.retry")}
                      </button>
                    </div>
                  )}
                  <Show when={data().rows.length} fallback={<Empty />}>
                    <SessionPanelGroups
                      kind="subagents"
                      running={running()}
                      finished={finished()}
                      keyFor={(row) => row.session.key}
                      finishedId={finishedId}
                      finishedOpen={finishedOpen()}
                      onToggleFinished={() => setFinishedOpen((value) => !value)}
                    >
                      {(row) => {
                        const stop = readiness.createStop(row);
                        const title = () =>
                          resolveSessionDisplayName(row().session.key, row().session);
                        const active = () => isSessionRunStateActive(row().session);
                        const activity = () =>
                          row().session.status === "queued"
                            ? t("common.queued")
                            : active()
                              ? row().activity || row().toolDisplayName
                              : undefined;
                        const stopLabel = () =>
                          stop.stopping()
                            ? t("chat.subagentsPanel.stopping")
                            : t("chat.subagentsPanel.stop", { name: title() });
                        const stopTitle = () => {
                          const access = row().stopAccess;
                          return access.allowed ? stopLabel() : access.reason;
                        };
                        return (
                          <div
                            class="chat-subagents__item"
                            role="listitem"
                            data-session-key={row().session.key}
                          >
                            <div class="chat-subagents__item-heading">
                              <button
                                class="chat-subagents__open"
                                type="button"
                                title={title()}
                                onClick={() =>
                                  setSelected({
                                    key: row().session.key,
                                    agentId: subagentAgentId(row().session.key),
                                  })
                                }
                              >
                                {title()}
                              </button>
                              {active() && row().session.activeRunIds?.length === 1 && (
                                <button
                                  class="chat-subagents__stop"
                                  type="button"
                                  aria-label={stopLabel()}
                                  title={stopTitle()}
                                  disabled={stop.stopping() || !row().canStop}
                                  onClick={() => void stop.stop()}
                                >
                                  <Icon name="square" />
                                </button>
                              )}
                            </div>
                            <div class="chat-subagents__metadata">
                              <span class="chat-subagents__work">
                                {row().callCount !== undefined && (
                                  <span class="chat-subagents__calls">
                                    {t(
                                      !row().callCount?.exact
                                        ? "chat.subagentsPanel.callsAtLeast"
                                        : row().callCount?.count === 1
                                          ? "chat.subagentsPanel.callsOne"
                                          : "chat.subagentsPanel.callsMany",
                                      { count: String(row().callCount?.count) },
                                    )}
                                  </span>
                                )}
                                {row().callCount !== undefined && activity() && (
                                  <span aria-hidden="true">·</span>
                                )}
                                {activity() && (
                                  <span
                                    ref={createTextOverflow(activity)}
                                    class="chat-subagents__activity"
                                    title={activity()}
                                  >
                                    {activity()}
                                  </span>
                                )}
                              </span>
                              <span
                                class="chat-subagents__elapsed"
                                title={t(
                                  active()
                                    ? "chat.subagentsPanel.elapsed"
                                    : "chat.subagentsPanel.duration",
                                )}
                              >
                                {renderElapsed(row())}
                              </span>
                            </div>
                          </div>
                        );
                      }}
                    </SessionPanelGroups>
                  </Show>
                </div>
              </ReadBoundary>
            </Show>
          }
        >
          {(identity) => (
            <openclaw-chat-pane
              class="chat-subagents__detail-pane"
              prop:paneId={props.paneId}
              prop:presentationId={identity}
              prop:sessionKey={selected()!.key}
              prop:agentId={selected()!.agentId}
              prop:inputRegion={props.inputRegion}
              prop:mergedChrome={props.mobile === true}
              prop:compact={true}
              prop:active={false}
              prop:presented={props.presented}
              prop:onBackToSubagents={() => setSelected(null)}
              prop:onPaneSessionChange={(
                _paneId: string,
                key: string,
                options?: PaneSessionChangeOptions,
              ) => props.onSessionSelect?.(key, options)}
            />
          )}
        </Show>
      </>
    );
  },
  {
    propertyChanged: (host, key) => {
      if (
        key === "sessionKey" ||
        key === "agentId" ||
        key === "presented" ||
        key === "showRequest"
      ) {
        syncSessionPanelInputs(host);
      }
    },
    properties: {
      sessionKey: { default: "", attribute: false },
      agentId: { default: "main", attribute: false },
      presented: { default: true, type: Boolean },
      paneId: { default: "single", attribute: false },
      presentationId: { default: "single", attribute: false },
      inputRegion: { default: "page", attribute: false },
      mobile: { default: undefined, attribute: false },
      onScrollPortRef: { default: undefined, attribute: false },
      doneExpanded: { default: undefined, attribute: false },
      onDoneExpandedChange: { default: undefined, attribute: false },
      showRequest: { default: undefined, attribute: false },
      onSessionSelect: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-subagents-panel": ChatSubagentsPanel;
  }
}
