import { Show, createEffect, createMemo, createSignal } from "solid-js";
import type { SessionProcessSummary } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import { ProcessesPanelData } from "../processes-panel-data.ts";
import {
  SessionPanelGroups,
  useSessionPanel,
  type SessionPanelProps,
} from "./chat-session-panel.tsx";
import "../../../components/elapsed-time.ts";
import "./chat-session-panels.css";
import "./chat-processes-panel.css";

type Methods = { refresh(): Promise<void> };
export type ChatProcessesPanel = SolidBridgeElement<SessionPanelProps, Methods>;

export const ChatProcessesPanel = defineSolidBridge<SessionPanelProps, Methods>(
  "openclaw-chat-processes-panel",
  (props, host) => {
    const [selected, setSelected] = createSignal<string | null>(null);
    const [finishedOpen, setFinishedOpen] = createSignal(false);
    const data = useSessionPanel(props, ProcessesPanelData, () => setSelected(null));
    host.refresh = () => data().refresh();
    createEffect(
      () => Boolean(data().error && !data().rows.length),
      (denied) => {
        if (denied) {
          setSelected(null);
        }
      },
    );
    const selectedRow = createMemo(() => data().rows.find((row) => row.instanceId === selected()));
    const running = createMemo(() => data().rows.filter((row) => row.status === "running"));
    const finished = createMemo(() => data().rows.filter((row) => row.status !== "running"));
    const status = (row: SessionProcessSummary) =>
      t(
        data().stopping.has(row.instanceId)
          ? "chat.processesPanel.stopping"
          : `chat.processesPanel.status.${row.status}`,
      );
    const elapsed = (row: SessionProcessSummary) =>
      (row.status === "running" || row.endedAt !== undefined) && (
        <openclaw-elapsed-time prop:startMs={row.startedAt} prop:endMs={row.endedAt ?? null} />
      );
    const stopButton = (row: SessionProcessSummary, detail = false) =>
      row.status === "running" &&
      row.canStop && (
        <button
          class="chat-processes__stop"
          type="button"
          aria-label={t("chat.processesPanel.stop", { name: row.name })}
          title={t("chat.processesPanel.stop", { name: row.name })}
          disabled={data().stopping.has(row.instanceId)}
          onClick={() => void data().stop(row)}
        >
          <Icon name="square" />
          {detail &&
            t(
              data().stopping.has(row.instanceId)
                ? "chat.processesPanel.stopping"
                : "chat.runControls.stop",
            )}
        </button>
      );
    const error = () =>
      data().error && (
        <div class="chat-processes__error" role="alert">
          {data().error}
          <button class="btn btn--sm" type="button" onClick={() => void data().refresh()}>
            {t("common.retry")}
          </button>
        </div>
      );
    return (
      <Show
        when={selected()}
        fallback={
          <div class="chat-processes__list" aria-busy={data().loading ? "true" : "false"}>
            {error()}
            <Show
              when={data().rows.length}
              fallback={
                <div class="chat-processes__empty" role="status">
                  {data().loading
                    ? t("common.loading")
                    : data().hasResult && !data().error
                      ? t("chat.processesPanel.empty")
                      : !data().error
                        ? t("chat.processesPanel.disconnected")
                        : null}
                </div>
              }
            >
              <SessionPanelGroups
                kind="processes"
                running={running()}
                finished={finished()}
                keyFor={(row) => row.instanceId}
                finishedOpen={finishedOpen()}
                onToggleFinished={() => setFinishedOpen((value) => !value)}
              >
                {(row) => (
                  <div
                    class="chat-processes__item"
                    role="listitem"
                    data-process-id={row().processId}
                  >
                    <div class="chat-processes__heading">
                      <button
                        class="chat-processes__open"
                        type="button"
                        title={row().name}
                        onClick={() => setSelected(row().instanceId)}
                      >
                        {row().name}
                      </button>
                      {stopButton(row())}
                    </div>
                    <div class="chat-processes__metadata">
                      <span class={row().status === "failed" ? "chat-processes__failure" : ""}>
                        {status(row())}
                        {row().exitCode != null &&
                          ` · ${t("chat.processesPanel.exitCode", { code: String(row().exitCode) })}`}
                      </span>
                      <span>{elapsed(row())}</span>
                    </div>
                  </div>
                )}
              </SessionPanelGroups>
            </Show>
            {data().truncated && (
              <p class="chat-processes__note">{t("chat.processesPanel.listTruncated")}</p>
            )}
          </div>
        }
      >
        <div class="chat-processes__detail">
          <header class="chat-processes__detail-header">
            <button class="chat-processes__back" type="button" onClick={() => setSelected(null)}>
              <Icon name="arrowLeft" />
              {t("chat.processesPanel.back")}
            </button>
            <Show when={selectedRow()}>
              {(row) => (
                <div class="chat-processes__heading">
                  <strong>{row().name}</strong>
                  {stopButton(row(), true)}
                </div>
              )}
            </Show>
          </header>
          {error()}
          <Show
            when={selectedRow()}
            fallback={
              <div class="chat-processes__empty" role="status">
                {t(
                  data().loading
                    ? "common.loading"
                    : data().hasResult
                      ? data().truncated
                        ? "chat.processesPanel.omitted"
                        : "chat.processesPanel.expired"
                      : "chat.processesPanel.disconnected",
                )}
              </div>
            }
          >
            {(row) => (
              <div class="chat-processes__output">
                <div class="chat-processes__metadata">
                  <span>{status(row())}</span>
                  <span>{elapsed(row())}</span>
                </div>
                {row().exitCode != null && (
                  <p class="chat-processes__note">
                    {t("chat.processesPanel.exitCode", { code: String(row().exitCode) })}
                  </p>
                )}
                {row().exitReason && <p class="chat-processes__note">{row().exitReason}</p>}
                <h3>{t("chat.processesPanel.output")}</h3>
                <pre>{row().tail || t("chat.processesPanel.noOutput")}</pre>
                <p class="chat-processes__note">{t("chat.processesPanel.retention")}</p>
                {row().truncated && (
                  <p class="chat-processes__note">{t("chat.processesPanel.outputTruncated")}</p>
                )}
              </div>
            )}
          </Show>
        </div>
      </Show>
    );
  },
  {
    properties: {
      sessionKey: { default: "", attribute: false },
      agentId: { default: "main", attribute: false },
      presented: { default: true, type: Boolean },
    },
    methods: { refresh: () => Promise.resolve() },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-processes-panel": ChatProcessesPanel;
  }
}
