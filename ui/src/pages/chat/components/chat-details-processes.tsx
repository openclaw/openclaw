import {
  Errored,
  For,
  Loading,
  Show,
  createMemo,
  createSignal,
  isPending,
  latest,
  onSettled,
} from "solid-js";
import type { SessionProcessSummary } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { registerChatDetailsEnglish } from "../../../i18n/locales/en-chat-details.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createKeyedListMotion } from "../../../lib/reactive/keyed-list-motion.ts";
import type { ProcessesPanelData } from "../processes-panel-data.ts";
import { ChatDetailsDesktopSection } from "./chat-details-desktop-section.tsx";
import "./chat-details-processes.css";
import { createDetailsProcessesPresentation } from "./chat-details-processes-presentation.ts";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import { createProcessesPresentation } from "./chat-processes-presentation.ts";

registerEnglishCatalog(registerChatSessionEnglish);
registerEnglishCatalog(registerChatDetailsEnglish);

type Props = {
  /** Read the native host's projection; it owns observation, refresh and stop authority. */
  processes: () => ProcessesPanelData | undefined;
  presented: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onOpen?: (instanceId?: string) => void;
  details: ChatDetailsProps;
};

function ProcessRow(props: {
  row: Pick<SessionProcessSummary, "processId" | "instanceId" | "name" | "canStop">;
  presentation: ReturnType<typeof createProcessesPresentation>;
  presented: boolean;
  onOpen: () => void;
  elementRef: (instanceId: string) => (element: HTMLDivElement) => void;
}) {
  const stop = createMemo(() => props.presentation.createStop(() => props.row));
  const nameOverflow = useScrollState(true, false, { revision: () => props.row.name });
  const status = () =>
    t(stop().stopping() ? "chat.processesPanel.stopping" : "chat.processesPanel.status.running");
  const description = () => `${props.row.name}. ${status()}`;
  return (
    <div
      ref={[props.elementRef(props.row.instanceId)]}
      class="chat-details-processes__row"
      role="listitem"
      data-process-id={props.row.processId}
      data-status="running"
      data-stopping={stop().stopping() ? "" : undefined}
      data-actionable={props.row.canStop ? "" : undefined}
    >
      <button
        class="chat-details-processes__open"
        type="button"
        aria-label={description()}
        disabled={!props.presented}
        onClick={() => props.onOpen()}
      >
        <span class="chat-details-processes__icon" aria-hidden="true">
          <Icon name="squareTerminal" />
          <span class="chat-details-processes__badge" data-status="running">
            <span class="chat-details-processes__spinner" />
          </span>
        </span>
        <span class="chat-details-processes__name" ref={nameOverflow}>
          {props.row.name}
        </span>
      </button>
      <Show when={props.row.canStop}>
        <button
          class="chat-details-processes__action chat-details-processes__stop"
          type="button"
          title={t("chat.processesPanel.stopProcess")}
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
  const live = createDetailsProcessesPresentation(() => snapshot()?.rows ?? []);
  const cached = () => props.details.cachedDetails?.processes;
  const visibleRows = createMemo(() =>
    snapshot()?.hasResult || snapshot()?.errorKind === "access"
      ? live().slice(0, 3)
      : (cached()?.rows ?? []).map(({ processId, instanceId, name }) => ({
          processId,
          instanceId,
          name,
          canStop: false,
        })),
  );
  const hidden = () =>
    (snapshot()?.hasResult ? live().length : (cached()?.total ?? 0)) - visibleRows().length;
  const receipt = createMemo(() =>
    (snapshot()?.hasResult || snapshot()?.errorKind === "access") && props.details.onDetailsSnapshot
      ? {
          write: props.details.onDetailsSnapshot,
          processes: {
            total: live().length,
            rows: visibleRows().map(({ processId, instanceId, name }) => ({
              processId,
              instanceId,
              name,
            })),
          },
        }
      : undefined,
  );
  const [revealing, setRevealing] = createSignal(false);
  const motion = createKeyedListMotion({
    ids: () => visibleRows().map((row) => row.instanceId),
    scope: presentation.scope,
    ready: () => Boolean(snapshot()?.hasResult || cached()),
    active: () =>
      props.presented && props.expanded && !revealing() && snapshot()?.errorKind !== "access",
  });
  const open = (instanceId?: string) => {
    if (props.presented) {
      props.onOpen?.(instanceId);
    }
  };
  const hasRunning = () => visibleRows().length > 0;
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
            <For each={visibleRows()} keyed={(row) => row.instanceId}>
              {(row) => (
                <ProcessRow
                  row={row()}
                  elementRef={motion.row}
                  presentation={presentation}
                  presented={props.presented}
                  onOpen={() => open(row().instanceId)}
                />
              )}
            </For>
          </div>
          <button
            class="chat-details-processes__view-all"
            type="button"
            disabled={!props.presented}
            onClick={() => open()}
          >
            {hidden() > 0
              ? t("chat.sessionDetails.showMore", { count: String(hidden()) })
              : t("chat.processesPanel.viewAll")}
          </button>
        </div>
      </Show>
    </>
  );
  const retry = () => void props.processes()?.refresh();
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
        {(latest(presentation.read), null)}
        <Content loading={isPending(presentation.read)} retry={retry} />
      </Loading>
    </Errored>
  );
  // The disclosure's layout owner must survive pending and errored body reads.
  return (
    <Show when={props.onOpen}>
      <Show when={receipt()} keyed>
        {(value) => {
          onSettled(() => value.write({ processes: value.processes }));
          return null;
        }}
      </Show>
      <Show when={motion.present()} fallback={<ReadContent />}>
        <div ref={motion.shell} class="chat-details-processes__envelope">
          <div ref={motion.content} class="chat-details-processes__motion-content">
            <Show when={hasRunning()}>
              <ChatDetailsDesktopSection
                section="processes"
                title={t("chat.sessionDetails.processes")}
                expanded={props.expanded}
                presented={props.presented}
                onExpandedChange={(expanded) => props.onExpandedChange(expanded)}
                onRevealMotionChange={setRevealing}
              >
                <ReadContent />
              </ChatDetailsDesktopSection>
            </Show>
          </div>
        </div>
      </Show>
    </Show>
  );
}
