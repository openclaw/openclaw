import type { JSX } from "@solidjs/web";
import { For, createEffect, createSignal, onCleanup } from "solid-js";
import type { ApplicationContext } from "../../../app/context.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { useApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";

export type SessionPanelProps = { sessionKey: string; agentId: string; presented: boolean };
type SessionPanelData = {
  dispose(): void;
  sync(input: SessionPanelProps): void;
  refresh(): Promise<void>;
};

/** Observe the existing data owner; it retains admission, polling and mutation authority. */
export function useSessionPanel<Data extends SessionPanelData>(
  props: SessionPanelProps,
  DataType: new (context: ApplicationContext, changed: () => void) => Data,
  clearSelection: () => void,
) {
  const [revision, setRevision] = createSignal(0);
  const data = new DataType(useApplication(), () => setRevision((value) => value + 1));
  let identity = "";
  createEffect(
    () => [props.sessionKey, props.agentId, props.presented] as const,
    ([sessionKey, agentId, presented]) => {
      const nextIdentity = JSON.stringify([sessionKey, agentId]);
      if (nextIdentity !== identity) {
        identity = nextIdentity;
        clearSelection();
      }
      data.sync({ sessionKey, agentId, presented });
    },
  );
  onCleanup(() => data.dispose());
  return () => {
    revision();
    return data;
  };
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
  const prefix = () => `chat-${props.kind}`;
  return (
    <>
      <section class={`${prefix()}__running`}>
        <h3 class={props.kind === "subagents" ? `${prefix()}__section-title` : undefined}>
          {t(`chat.${props.kind}Panel.running`, { count: String(props.running.length) })}
        </h3>
        <div role="list">
          <For each={props.running} keyed={props.keyFor}>
            {props.children}
          </For>
        </div>
        {!props.running.length && (
          <div class={`${prefix()}__empty`}>{t(`chat.${props.kind}Panel.noRunning`)}</div>
        )}
      </section>
      <section class={`${prefix()}__finished`}>
        <button
          class={`${prefix()}__finished-toggle`}
          type="button"
          aria-expanded={props.finishedOpen}
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
