import { createMemo, createSignal, createUniqueId, For, onSettled, Show } from "solid-js";
import type { SessionProcessSummary } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { ElapsedTime } from "../../../components/elapsed-time.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { useApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectMutableSource } from "../../../lib/reactive/projection.ts";
import { isChatRunWorking } from "../chat-run-working.ts";
import { ProcessesPanelData } from "../processes-panel-data.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";

type Waiter = Pick<SessionProcessSummary, "instanceId" | "name" | "startedAt">;
type Open = ChatComposerProps["onOpenProcesses"];

function WaiterName(props: { name: string }) {
  const overflow = useScrollState(true, false, { revision: () => props.name });
  return (
    <span class="chat-waiters__name" ref={overflow}>
      {props.name}
    </span>
  );
}

/** "Waiting on <name>": the translation places the name, the row renders it. */
function WaitingOn(props: { name: string }) {
  const parts = createMemo(() =>
    t("chat.processesPanel.waitingOn", { name: "\u0000" }).split("\u0000"),
  );
  return (
    <span class="chat-waiters__label">
      {parts()[0]}
      <WaiterName name={props.name} />
      {parts()[1]}
    </span>
  );
}

function WaiterRow(props: { waiter: Waiter; nested?: boolean; onOpen: Open }) {
  const content = () => (
    <>
      <span class="chat-waiters__icon" aria-hidden="true">
        {props.nested ? <Icon name="squareTerminal" /> : <span class="session-run-spinner" />}
      </span>
      {props.nested ? (
        <WaiterName name={props.waiter.name} />
      ) : (
        <WaitingOn name={props.waiter.name} />
      )}
      <ElapsedTime class="chat-waiters__elapsed" startMs={props.waiter.startedAt} />
      <Show when={props.onOpen}>
        <span class="chat-waiters__icon" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </Show>
    </>
  );
  return (
    <Show when={props.onOpen} fallback={<div class="chat-waiters__row">{content()}</div>}>
      {(open) => (
        <button
          class="chat-waiters__row"
          type="button"
          onClick={() => open()(props.waiter.instanceId)}
        >
          {content()}
        </button>
      )}
    </Show>
  );
}

function Waiters(props: { composer: ChatComposerProps }) {
  const app = useApplication();
  let publish = () => {};
  // The shared observation owner keeps reads, events and polling; this view only filters.
  const data = new ProcessesPanelData(app, () => publish());
  const view = projectMutableSource(data, (source) => source.snapshot);
  publish = view.publish;
  // The caller remounts this view per session, so its identity is fixed for the owner's life.
  onSettled(() => {
    data.sync({
      sessionKey: props.composer.sessionKey,
      agentId: props.composer.currentAgentId,
      presented: true,
    });
    return () => {
      view.dispose();
      data.dispose();
    };
  });
  const waiters = createMemo(() =>
    view
      .read()
      .rows.filter((row) => row.status === "running" && row.wakesSession)
      .toSorted((a, b) => a.startedAt - b.startedAt),
  );
  const [open, setOpen] = createSignal(false);
  const listId = createUniqueId();
  return (
    // A running turn owns the status line; the observation stays warm meanwhile.
    <Show when={!isChatRunWorking(props.composer) && waiters().length}>
      <section class="chat-waiters" aria-label={t("chat.processesPanel.waitingTitle")}>
        <Show
          when={waiters().length === 1 ? waiters()[0] : undefined}
          fallback={
            <>
              <button
                class="chat-waiters__row"
                type="button"
                aria-expanded={open() ? "true" : "false"}
                aria-controls={listId}
                onClick={() => setOpen(!open())}
              >
                <span class="chat-waiters__icon" aria-hidden="true">
                  <span class="session-run-spinner" />
                </span>
                <span class="chat-waiters__label">
                  {t("chat.processesPanel.waitingOnCount", { count: String(waiters().length) })}
                </span>
                <ElapsedTime class="chat-waiters__elapsed" startMs={waiters()[0]!.startedAt} />
                <span class="chat-waiters__icon" aria-hidden="true">
                  <Icon name={open() ? "chevronDown" : "chevronRight"} />
                </span>
              </button>
              <div id={listId} class="chat-waiters__list" role="list" hidden={!open()}>
                <For each={waiters()} keyed={(waiter) => waiter.instanceId}>
                  {(waiter) => (
                    <div role="listitem">
                      <WaiterRow waiter={waiter()} nested onOpen={props.composer.onOpenProcesses} />
                    </div>
                  )}
                </For>
              </div>
            </>
          }
        >
          {(waiter) => <WaiterRow waiter={waiter()} onOpen={props.composer.onOpenProcesses} />}
        </Show>
      </section>
    </Show>
  );
}

/**
 * Background commands this idle chat waits on. Their exit continues the chat,
 * so the user can see what is pending and open its live output.
 */
export function ChatComposerWaiters(props: { composer: ChatComposerProps }) {
  const identity = () => JSON.stringify([props.composer.currentAgentId, props.composer.sessionKey]);
  return (
    <Show when={identity()} keyed>
      {(_identity: string) => <Waiters composer={props.composer} />}
    </Show>
  );
}
