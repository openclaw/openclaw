import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { showConfirmDialog } from "../../../components/confirm-dialog.ts";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { SubagentDesktopAvatar } from "./chat-subagents-panel-desktop.tsx";
import "./chat-subagents-mobile.css";

export type ChatSubagentMobileStop = {
  label: string;
  accessibleLabel: string;
  disabled: boolean;
  pending: boolean;
  disabledReason?: string;
  confirmation: {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    signal?: AbortSignal;
  };
  /** Bound to this session/run; the native owner revalidates it after confirmation. */
  onConfirm: () => void | Promise<void>;
};

export type ChatSubagentMobileItem = {
  key: string;
  title: string;
  status: "running" | "waiting" | "queued" | "finished" | "failed" | "stopped";
  statusLabel: string;
  activity?: string;
  /** Localized native count, including the lower-bound marker when not exact. */
  calls?: string;
  /** The native elapsed-time element or formatted duration; no presenter timer. */
  elapsed?: JSX.Element;
  elapsedLabel?: string;
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
  /** The navigation owner retains/restores list scroll across child navigation. */
  listRef?: (element: HTMLDivElement, firstButton: () => HTMLButtonElement | undefined) => void;
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
};

type ChatSubagentMobileHeaderProps = {
  title: string;
  sessionKey: string;
  backLabel: string;
  onBack: () => void;
  stop?: ChatSubagentMobileStop;
  /** Preserve any native child-pane actions, such as Details. */
  actions?: JSX.Element;
};

const statusIcons: Record<Exclude<ChatSubagentMobileItem["status"], "running">, IconName> = {
  waiting: "clock",
  queued: "clock",
  finished: "check",
  failed: "alertTriangle",
  stopped: "stop",
};

function MobileStop(props: { action: ChatSubagentMobileStop }) {
  const confirmStop = async () => {
    const action = props.action;
    if (action.disabled || action.pending) {
      return;
    }
    // Capture the native target-bound callback before the modal can outlive a row update.
    const onConfirm = action.onConfirm;
    if (await showConfirmDialog({ ...action.confirmation, danger: true })) {
      await onConfirm();
    }
  };
  return (
    <button
      class="chat-subagents-mobile__stop"
      type="button"
      disabled={props.action.disabled || props.action.pending}
      aria-busy={props.action.pending ? "true" : "false"}
      aria-label={props.action.accessibleLabel}
      onClick={() => void confirmStop()}
    >
      <Icon name="stop" />
      <span>{props.action.label}</span>
    </button>
  );
}

function MobileRow(props: {
  item: ChatSubagentMobileItem;
  onOpen: (key: string) => void;
  registerOpen: (key: string, button: HTMLButtonElement) => () => void;
}) {
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
        {(stop) => <MobileStop action={stop()} />}
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

function MobileTitle(props: { title: string }) {
  const titleRef = useScrollState(true, false);
  return (
    <span class="chat-subagents-mobile__title" ref={titleRef}>
      {props.title}
    </span>
  );
}

export function ChatSubagentMobileHeader(props: ChatSubagentMobileHeaderProps) {
  return (
    <div class="chat-subagents-mobile__header">
      <button
        class="chat-subagents-mobile__back"
        type="button"
        aria-label={props.backLabel}
        onClick={() => props.onBack()}
      >
        <Icon name="chevronLeft" />
      </button>
      <SubagentDesktopAvatar sessionKey={props.sessionKey} />
      <Show when={props.title} keyed>
        {(title) => <MobileTitle title={title} />}
      </Show>
      <Show when={props.stop && !props.stop.disabled ? props.stop : undefined}>
        {(stop) => <MobileStop action={stop()} />}
      </Show>
      {props.actions}
    </div>
  );
}
