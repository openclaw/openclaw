import { Show, createEffect, createMemo, createSignal } from "solid-js";
import type { ChatInputRegion } from "../../../app/chat-input-owner.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import { isSessionRunActive } from "../../../lib/session-run-state.ts";
import { parseAgentSessionKey } from "../../../lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import type { PaneSessionChangeOptions } from "../chat-pane-shared.ts";
import { isUnfinishedSubagent } from "../chat-spawned-subagent.ts";
import { SubagentsPanelData, type SubagentsPanelRow } from "../subagents-panel-data.ts";
import {
  SessionPanelGroups,
  useSessionPanel,
  type SessionPanelProps,
} from "./chat-session-panel.tsx";
import "../../../components/elapsed-time.ts";
import "./chat-session-panels.css";
import "./chat-subagents-panel.css";

type Props = SessionPanelProps & {
  paneId: string;
  presentationId: string;
  inputRegion: ChatInputRegion;
  showRequest?: () => string | null | undefined;
  onSessionSelect?: (sessionKey: string, options?: PaneSessionChangeOptions) => boolean | void;
};
type Methods = { refresh(): Promise<void> };
export type ChatSubagentsPanel = SolidBridgeElement<Props, Methods>;
let panelSequence = 0;

export const ChatSubagentsPanel = defineSolidBridge<Props, Methods>(
  "openclaw-chat-subagents-panel",
  (props, host) => {
    const [selected, setSelected] = createSignal<{ key: string; agentId: string } | null>(null);
    const [finishedOpen, setFinishedOpen] = createSignal(true);
    const finishedId = `chat-subagents-finished-${++panelSequence}`;
    const data = useSessionPanel(props, SubagentsPanelData, () => setSelected(null));
    host.refresh = () => data().refresh();
    const subagentAgentId = (key: string) =>
      data().rows.find((row) => row.session.key === key)?.session.agentId ??
      parseAgentSessionKey(key)?.agentId ??
      props.agentId;
    createEffect(
      () => props.showRequest,
      (request) => {
        const key = request?.();
        if (key !== undefined) {
          setSelected(key ? { key, agentId: subagentAgentId(key) } : null);
        }
      },
    );
    createEffect(
      () => {
        const value = selected();
        const owner = data();
        return (
          value &&
          !owner.loading &&
          ((owner.error && !owner.rows.length) ||
            (owner.hasResult &&
              !owner.error &&
              !owner.rows.some((row) => row.session.key === value.key)))
        );
      },
      (removed) => {
        if (removed) {
          setSelected(null);
        }
      },
    );
    const unfinished = (row: SubagentsPanelRow) =>
      row.session.status === "queued" || isUnfinishedSubagent(row.session);
    const running = createMemo(() => data().rows.filter(unfinished));
    const finished = createMemo(() => data().rows.filter((row) => !unfinished(row)));
    const detailId = createMemo(() =>
      selected() ? `${props.presentationId}:subagent:${selected()!.key}` : undefined,
    );
    const renderElapsed = (row: SubagentsPanelRow) => {
      const session = row.session;
      const active = isSessionRunActive(session);
      if (session.runtimeMs != null) {
        return active && session.runtimeSampledAt != null ? (
          <openclaw-elapsed-time prop:startMs={session.runtimeSampledAt - session.runtimeMs} />
        ) : (
          formatDurationCompact(session.runtimeMs)
        );
      }
      return (
        session.startedAt != null &&
        (active || session.endedAt != null) && (
          <openclaw-elapsed-time
            prop:startMs={session.startedAt}
            prop:endMs={active ? null : session.endedAt}
          />
        )
      );
    };
    return (
      <Show
        when={detailId()}
        keyed
        fallback={
          <div class="chat-subagents__list" aria-busy={data().loading ? "true" : "false"}>
            {data().error && (
              <div class="chat-subagents__error" role="alert">
                <span>{data().error}</span>
                <button class="btn btn--sm" type="button" onClick={() => void data().refresh()}>
                  {t("common.retry")}
                </button>
              </div>
            )}
            <Show
              when={data().rows.length}
              fallback={
                (data().loading || (data().hasResult && !data().error)) && (
                  <div class="chat-subagents__empty" role="status">
                    {t(data().loading ? "common.loading" : "chat.subagentsPanel.empty")}
                  </div>
                )
              }
            >
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
                  const title = () => resolveSessionDisplayName(row().session.key, row().session);
                  const active = () => isSessionRunActive(row().session);
                  const activity = () =>
                    row().session.status === "queued"
                      ? t("common.queued")
                      : active()
                        ? row().activity || row().toolDisplayName
                        : undefined;
                  const stopLabel = () =>
                    row().stopping
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
                            disabled={row().stopping || !row().canStop}
                            onClick={() => void data().stop(row())}
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
                                row().callCount === 1
                                  ? "chat.subagentsPanel.callsOne"
                                  : "chat.subagentsPanel.callsMany",
                                { count: String(row().callCount) },
                              )}
                            </span>
                          )}
                          {row().callCount !== undefined && activity() && (
                            <span aria-hidden="true">·</span>
                          )}
                          {activity() && (
                            <span class="chat-subagents__activity" title={activity()}>
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
    );
  },
  {
    properties: {
      sessionKey: { default: "", attribute: false },
      agentId: { default: "main", attribute: false },
      presented: { default: true, type: Boolean },
      paneId: { default: "single", attribute: false },
      presentationId: { default: "single", attribute: false },
      inputRegion: { default: "page", attribute: false },
      showRequest: { default: undefined, attribute: false },
      onSessionSelect: { default: undefined, attribute: false },
    },
    methods: { refresh: () => Promise.resolve() },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-subagents-panel": ChatSubagentsPanel;
  }
}
