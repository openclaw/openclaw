import type { JSX } from "@solidjs/web";
import { Errored, Loading, Show, createMemo, createSignal } from "solid-js";
import { showConfirmDialog } from "../../../components/confirm-dialog.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { SubagentDesktopAvatar } from "./chat-subagent-avatar.tsx";
import type { SubagentStopControl } from "./chat-subagents-presentation.ts";
import "./chat-subagents-mobile.css";

registerEnglishCatalog(registerChatSessionEnglish);

export type ChatSubagentMobileStop = {
  /** Stable session/run identity; preparation feedback must not follow a successor. */
  target: string;
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

type ChatSubagentMobileHeaderProps = {
  title: string;
  sessionKey: string;
  backLabel: string;
  onBack: () => void;
  stop?: ChatSubagentMobileStop;
  /** Preserve any native child-pane actions, such as Details. */
  actions?: JSX.Element;
};

export function MobileStop(props: {
  action: ChatSubagentMobileStop;
  control?: SubagentStopControl;
}) {
  const [completion, setCompletion] = createSignal<{ target: string; result: Promise<void> }>();
  const currentCompletion = () => {
    const receipt = completion();
    return receipt?.target === props.action.target ? receipt.result : undefined;
  };
  const completed = createMemo(() => currentCompletion()?.then(() => null) ?? null);
  const pending = () => Boolean(props.control?.stopping()) || props.action.pending;
  const confirmStop = async () => {
    const action = props.action;
    if (action.disabled || pending()) {
      return;
    }
    // Capture the native target-bound callback before the modal can outlive a row update.
    const onConfirm = props.control?.capture() ?? action.onConfirm;
    if (await showConfirmDialog({ ...action.confirmation, danger: true })) {
      await onConfirm();
    }
  };
  return (
    <>
      <button
        class="chat-subagents-mobile__stop"
        type="button"
        disabled={props.action.disabled || pending()}
        aria-busy={pending() ? "true" : "false"}
        aria-label={pending() ? t("chat.subagentsPanel.stopping") : props.action.accessibleLabel}
        onClick={() => {
          const target = props.action.target;
          const result = confirmStop();
          setCompletion({ target, result });
          void result.catch(() => {});
        }}
      >
        <Icon name="stop" />
        <span>{pending() ? t("chat.subagentsPanel.stopping") : props.action.label}</span>
      </button>
      <Loading on={currentCompletion()}>
        <Errored
          fallback={(error) => (
            <span class="chat-subagents-mobile__error" role="alert">
              {formatUiError(error())}
            </span>
          )}
        >
          {completed()}
        </Errored>
      </Loading>
    </>
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
