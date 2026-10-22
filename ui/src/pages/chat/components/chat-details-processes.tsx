import { Errored, For, Loading, Show, createMemo, isPending, latest } from "solid-js";
import type { SessionProcessSummary } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ProcessesPanelData } from "../processes-panel-data.ts";
import "./chat-details-processes.css";
import { ChatDetailsDesktopSection } from "./chat-details-desktop-section.tsx";
import { createProcessesPresentation } from "./chat-processes-presentation.ts";

registerEnglishCatalog(registerChatSessionEnglish);

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
  presentation: ReturnType<typeof createProcessesPresentation>;
  presented: boolean;
  onOpen: () => void;
}) {
  const stop = createMemo(() => props.presentation.createStop(() => props.row));
  const nameOverflow = useScrollState(true, false, { revision: () => props.row.name });
  const status = () =>
    t(
      stop().stopping()
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
      data-stopping={stop().stopping() ? "" : undefined}
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
            stop().stopping() ? status() : t("chat.processesPanel.stop", { name: props.row.name })
          }
          aria-label={t("chat.processesPanel.stop", { name: props.row.name })}
          disabled={!props.presented || stop().stopping()}
          onClick={() => {
            if (props.presented) {
              void stop().stop();
            }
          }}
        >
          <Show when={stop().stopping()} fallback={<Icon name="stop" />}>
            <span class="chat-details-processes__spinner" />
          </Show>
        </button>
      </Show>
      <Show when={stop().stopping()}>
        <span class="sr-only" role="status">
          {status()}
        </span>
      </Show>
    </div>
  );
}

/** Desktop list using the same process snapshot and operations as the full panel. */
export function ChatDetailsProcesses(props: Props) {
  const presentation = createProcessesPresentation(() => props.processes(), true);
  const snapshot = () => props.processes()?.snapshot;
  const rows = createMemo(() =>
    (snapshot()?.rows ?? []).toSorted((a, b) => order[a.status] - order[b.status]),
  );
  const open = () => {
    if (props.presented) {
      props.onOpen?.();
    }
  };
  const hasRunning = () => rows().some((row) => row.status === "running");
  const ProcessError = (errorProps: { loading: boolean; retry: () => void }) => (
    <Show when={snapshot()?.errorKind !== "read" && snapshot()?.error}>
      {(error) => (
        <div class="chat-details-processes__error" role="alert">
          <span>{error()}</span>
          <button
            class="chip"
            type="button"
            disabled={!props.presented || errorProps.loading}
            onClick={() => errorProps.retry()}
          >
            {t("common.retry")}
          </button>
        </div>
      )}
    </Show>
  );
  const Content = (contentProps: { loading: boolean; retry: () => void }) => (
    <>
      <Show when={!hasRunning()}>
        <ProcessError loading={contentProps.loading} retry={contentProps.retry} />
      </Show>
      <Show when={hasRunning()}>
        <div class="chat-details-processes" aria-busy={contentProps.loading ? "true" : "false"}>
          <ProcessError loading={contentProps.loading} retry={contentProps.retry} />
          <div
            class="chat-details-processes__list"
            role="list"
            aria-label={t("chat.sessionDetails.processes")}
          >
            <For each={rows()} keyed={(row) => row.instanceId}>
              {(row) => (
                <ProcessRow
                  row={row()}
                  presentation={presentation}
                  presented={props.presented}
                  onOpen={open}
                />
              )}
            </For>
          </div>
          <Show when={snapshot()?.truncated}>
            <div class="chat-details__muted">{t("chat.processesPanel.listTruncated")}</div>
          </Show>
        </div>
      </Show>
    </>
  );
  const retry = () => void props.processes()?.refresh();
  const consumeRead = () => {
    latest(presentation.read);
    return null;
  };
  const ReadContent = () => (
    <Errored
      fallback={(_error, reset) => (
        <Content
          loading={isPending(presentation.read)}
          retry={() => {
            retry();
            reset();
          }}
        />
      )}
    >
      <Loading on={presentation.scope()} fallback={<Content loading retry={retry} />}>
        {consumeRead()}
        <Content loading={isPending(presentation.read)} retry={retry} />
      </Loading>
    </Errored>
  );
  // The disclosure's layout owner must survive pending and errored body reads.
  return (
    <Show when={props.onOpen}>
      <Show when={hasRunning()} fallback={<ReadContent />}>
        <ChatDetailsDesktopSection
          section="processes"
          title={t("chat.sessionDetails.processes")}
          expanded={props.expanded}
          presented={props.presented}
          onExpandedChange={(expanded) => props.onExpandedChange(expanded)}
        >
          <ReadContent />
        </ChatDetailsDesktopSection>
      </Show>
    </Show>
  );
}
