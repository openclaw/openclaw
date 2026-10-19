import type { JSX } from "@solidjs/web";
import { For, onSettled } from "solid-js";
import type { ApplicationContext } from "../../../app/context.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { useApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectSource } from "../../../lib/reactive/projection.ts";

export type SessionPanelProps = { sessionKey: string; agentId: string; presented: boolean };
type SessionPanelData = {
  dispose(): void;
  sync(input: SessionPanelProps): void;
  refresh(): Promise<void>;
};
const inputHandlers = new WeakMap<HTMLElement, () => void>();

export function syncSessionPanelInputs(host: HTMLElement): void {
  inputHandlers.get(host)?.();
}

/** Observe the existing data owner; it retains admission, polling and mutation authority. */
export function useSessionPanel<Data extends SessionPanelData>(
  host: HTMLElement,
  readInputs: () => SessionPanelProps,
  DataType: new (context: ApplicationContext, changed: () => void) => Data,
  syncSelection: (identityChanged: boolean) => void,
) {
  let changed = () => {};
  const data = new DataType(useApplication(), () => changed());
  const view = projectSource(data, {
    read: (source) => source,
    subscribe: (_source, notify) => {
      changed = notify;
      return () => {
        changed = () => {};
      };
    },
    equality: "revision",
  });
  let identity = "";
  let active = false;
  let queued = false;
  const sync = () => {
    if (!active) {
      return;
    }
    const inputs = readInputs();
    const nextIdentity = JSON.stringify([inputs.sessionKey, inputs.agentId]);
    const identityChanged = nextIdentity !== identity;
    identity = nextIdentity;
    data.sync(inputs);
    // A show request can precede the related identity setters in the same batch.
    syncSelection(identityChanged);
  };
  onSettled(() => {
    active = true;
    inputHandlers.set(host, () => {
      const inputs = readInputs();
      if (!inputs.presented || JSON.stringify([inputs.sessionKey, inputs.agentId]) !== identity) {
        // Retire old reads immediately, then admit only the final related host inputs.
        data.sync({ ...inputs, presented: false });
      }
      if (!queued) {
        queued = true;
        queueMicrotask(() => {
          queued = false;
          sync();
        });
      }
    });
    sync();
    return () => {
      active = false;
      inputHandlers.delete(host);
      view.dispose();
      data.dispose();
    };
  });
  return view.read;
}

export function SessionPanelGroups<Row>(props: {
  kind: "processes" | "subagents";
  running: readonly Row[];
  finished: readonly Row[];
  keyFor: (row: Row) => unknown;
  children: (row: () => Row) => JSX.Element;
  finishedOpen: boolean;
  onToggleFinished: () => void;
  finishedId?: string;
}) {
  return (
    <>
      <section class={[`chat-${props.kind}__running`]}>
        <h3 class={{ "chat-subagents__section-title": props.kind === "subagents" }}>
          {t(`chat.${props.kind}Panel.running`, { count: String(props.running.length) })}
        </h3>
        <div role="list">
          <For each={props.running} keyed={props.keyFor}>
            {props.children}
          </For>
        </div>
        {!props.running.length && (
          <div class={[`chat-${props.kind}__empty`]}>{t(`chat.${props.kind}Panel.noRunning`)}</div>
        )}
      </section>
      <section class={[`chat-${props.kind}__finished`]}>
        <button
          class={[`chat-${props.kind}__finished-toggle`]}
          type="button"
          aria-expanded={props.finishedOpen ? "true" : "false"}
          aria-controls={props.finishedId}
          onClick={() => props.onToggleFinished()}
        >
          <span>
            {t(`chat.${props.kind}Panel.finished`, { count: String(props.finished.length) })}
          </span>
          <Icon name={props.finishedOpen ? "chevronDown" : "chevronRight"} />
        </button>
        <div id={props.finishedId} role="list" hidden={!props.finishedOpen}>
          {props.finishedOpen && (
            <For each={props.finished} keyed={props.keyFor}>
              {props.children}
            </For>
          )}
        </div>
      </section>
    </>
  );
}
