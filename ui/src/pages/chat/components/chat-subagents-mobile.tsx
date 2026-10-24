import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import "./chat-subagents-mobile.css";
import { SubagentDesktopAvatar } from "./chat-subagent-avatar.tsx";
import { MobileStop, type ChatSubagentMobileStop } from "./chat-subagent-mobile-header.tsx";
import type { SubagentStopControl } from "./chat-subagents-presentation.ts";

registerEnglishCatalog(registerChatSessionEnglish);

export type ChatSubagentMobileItem = {
  key: string;
  title: string;
  status: "running" | "waiting" | "queued" | "finished" | "failed" | "stopped";
  statusLabel: string;
  /** The native elapsed-time element or formatted duration; no presenter timer. */
  elapsed?: JSX.Element;
  /** Omitted when the native owner does not offer Stop for this run. */
  stop?: ChatSubagentMobileStop;
};

export type ChatSubagentsMobileListProps = {
  running: readonly ChatSubagentMobileItem[];
  finished: readonly ChatSubagentMobileItem[];
  runningLabel: string;
  finishedLabel: string;
  noRunningLabel: string;
  finishedId: string;
  finishedOpen: boolean;
  onToggleFinished: () => void;
  onOpen: (key: string) => void;
  /** Parent-owned loading/error/retry and empty feedback. */
  notice?: JSX.Element;
  empty?: JSX.Element;
  loading: boolean;
  emptyLoading?: boolean;
  createStop: (key: () => string) => SubagentStopControl;
  /** The navigation owner retains/restores list scroll across child navigation. */
  listRef?: (element: HTMLDivElement, firstButton: () => HTMLButtonElement | undefined) => void;
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
};

const statusIcons: Record<Exclude<ChatSubagentMobileItem["status"], "running">, IconName> = {
  waiting: "clock",
  queued: "clock",
  finished: "check",
  failed: "alertTriangle",
  stopped: "stop",
};

function MobileRow(props: {
  item: ChatSubagentMobileItem;
  createStop: ChatSubagentsMobileListProps["createStop"];
  onOpen: (key: string) => void;
  registerOpen: (key: string, button: HTMLButtonElement) => () => void;
}) {
  const control = props.createStop(() => props.item.key);
  const nameScrollState = useScrollState(true, false);
  const finished = () => ["finished", "failed", "stopped"].includes(props.item.status);
  return (
    <div
      class={["chat-subagents-mobile__row", { "chat-subagents-mobile__row--finished": finished() }]}
      role="listitem"
      data-session-key={props.item.key}
    >
      <button
        class="chat-subagents-mobile__open"
        ref={[elementRef(props.registerOpen.bind(undefined, props.item.key))]}
        type="button"
        onClick={() => props.onOpen(props.item.key)}
      >
        <span
          class="chat-subagents-mobile__indicator"
          data-status={props.item.status}
          role="img"
          aria-label={props.item.statusLabel}
        >
          <SubagentDesktopAvatar
            sessionKey={props.item.key}
            working={props.item.status === "running"}
          />
          {props.item.status !== "running" && (
            <Icon class="chat-subagents-mobile__status" name={statusIcons[props.item.status]} />
          )}
        </span>
        <span class="chat-subagents-mobile__copy">
          <strong ref={nameScrollState}>{props.item.title}</strong>
          {!finished() && props.item.elapsed && (
            <span class="chat-subagents-mobile__stats">
              {props.item.status === "running" && (
                <span>{t("chat.subagentsPanel.workingFor")}</span>
              )}
              {props.item.elapsed}
            </span>
          )}
        </span>
      </button>
      {finished() && <span class="chat-subagents-mobile__elapsed">{props.item.elapsed}</span>}
      <Show when={props.item.stop && !props.item.stop.disabled ? props.item.stop : undefined}>
        {(stop) => <MobileStop action={stop()} control={control} />}
      </Show>
      <Icon class="chat-subagents-mobile__chevron" name="chevronRight" />
    </div>
  );
}

export function ChatSubagentsMobileList(props: ChatSubagentsMobileListProps) {
  const openButtons = new Map<string, HTMLButtonElement>();
  let finishedToggle: HTMLButtonElement | undefined;
  const registerOpen = (key: string, button: HTMLButtonElement) => {
    openButtons.set(key, button);
    return () => {
      if (openButtons.get(key) === button) {
        openButtons.delete(key);
      }
    };
  };
  const firstButton = () => {
    const first = props.running[0];
    const button = first ? openButtons.get(first.key) : finishedToggle;
    return button?.isConnected ? button : undefined;
  };
  return (
    <div
      class="chat-subagents-mobile"
      style={{ padding: props.emptyLoading ? "0" : undefined }}
      ref={[(element) => props.listRef?.(element, firstButton), elementRef(props.onScrollPortRef)]}
      aria-busy={props.loading ? "true" : "false"}
    >
      {props.notice}
      <Show when={props.running.length + props.finished.length} fallback={props.empty}>
        <section class="chat-subagents-mobile__group">
          <h3 class="chat-subagents-mobile__heading">
            <span>{props.runningLabel}</span>
            <span>{props.running.length}</span>
          </h3>
          <Show
            when={props.running.length}
            fallback={<p class="chat-subagents-mobile__empty">{props.noRunningLabel}</p>}
          >
            <div class="chat-subagents-mobile__list" role="list" aria-label={props.runningLabel}>
              <For each={props.running} keyed={(item) => item.key}>
                {(item) => (
                  <MobileRow
                    item={item()}
                    createStop={props.createStop}
                    onOpen={(key) => props.onOpen(key)}
                    registerOpen={registerOpen}
                  />
                )}
              </For>
            </div>
          </Show>
        </section>
        <section class="chat-subagents-mobile__group">
          <button
            class="chat-subagents-mobile__disclosure"
            ref={(button) => {
              finishedToggle = button;
            }}
            type="button"
            aria-expanded={props.finishedOpen ? "true" : "false"}
            aria-controls={props.finishedId}
            onClick={() => props.onToggleFinished()}
          >
            <span class="chat-subagents-mobile__heading">
              <span>{props.finishedLabel}</span>
              <span>{props.finished.length}</span>
            </span>
            <Icon name={props.finishedOpen ? "chevronDown" : "chevronRight"} />
          </button>
          <div
            class="chat-subagents-mobile__list"
            id={props.finishedId}
            role="list"
            aria-label={props.finishedLabel}
            hidden={!props.finishedOpen}
          >
            <Show when={props.finishedOpen}>
              <For each={props.finished} keyed={(item) => item.key}>
                {(item) => (
                  <MobileRow
                    item={item()}
                    createStop={props.createStop}
                    onOpen={(key) => props.onOpen(key)}
                    registerOpen={registerOpen}
                  />
                )}
              </For>
            </Show>
          </div>
        </section>
      </Show>
    </div>
  );
}
