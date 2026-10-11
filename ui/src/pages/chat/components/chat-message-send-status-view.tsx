import { Show } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import type { readPendingSendStatus } from "../chat-thread-items.ts";

export type ChatSendStatusActions = {
  onRetryQueuedMessage?: (id: string) => void;
  onDiscardQueuedMessage?: (id: string) => void;
  queuedMessageAction?: { id: string; label?: string; onAction?: () => void };
};

type SendStatus = ReturnType<typeof readPendingSendStatus>;

function SendStatusAction(props: {
  kind: "retry" | "discard";
  id: string;
  callback?: (id: string) => void;
  label?: string;
}) {
  return (
    <Show when={props.callback}>
      <span class="chat-send-status__part">
        <span aria-hidden="true">{"·"}</span>
        <button
          class={"chat-send-status__action chat-send-status__" + props.kind}
          type="button"
          aria-label={
            props.kind === "retry" ? (props.label ?? t("chat.queue.retryQueuedMessage")) : undefined
          }
          title={props.kind === "discard" ? t("chat.queue.discardPendingMessage") : undefined}
          onClick={(event: MouseEvent) => {
            // Chromium may retarget click 2 to the next row after removal.
            if (props.kind === "retry" || event.detail <= 1) {
              props.callback?.(props.id);
            }
          }}
        >
          {props.kind === "retry"
            ? (props.label ?? t("chat.queue.retry"))
            : t("chat.queue.discard")}
        </button>
      </span>
    </Show>
  );
}

export function renderSolidChatSendStatus(status: SendStatus, actions: ChatSendStatusActions) {
  return <ChatSendStatus status={status} actions={actions} />;
}

export function ChatSendStatus(props: { status: SendStatus; actions: ChatSendStatusActions }) {
  const action = () =>
    props.actions.queuedMessageAction?.id === props.status?.id
      ? props.actions.queuedMessageAction
      : undefined;
  const reconnecting = () => props.status?.state === "waiting-reconnect";
  const retry = () =>
    reconnecting() ? undefined : (action()?.onAction ?? props.actions.onRetryQueuedMessage);
  const discard = () =>
    props.status &&
    (props.status.state === "failed" ||
      props.status.state === "unconfirmed" ||
      props.status.state === "held" ||
      reconnecting()) &&
    !action()
      ? props.actions.onDiscardQueuedMessage
      : undefined;
  return (
    <Show when={props.status}>
      {(status) => (
        <span
          class="chat-send-status"
          title={status().error ?? undefined}
          data-send-state={status().state}
        >
          <span class="chat-send-status__part">
            <span aria-hidden="true">{"·"}</span>
            <span>
              {t(
                reconnecting()
                  ? "chat.queue.states.waitingForReconnect"
                  : status().state === "held"
                    ? "chat.queue.states.needsReview"
                    : status().state === "unconfirmed"
                      ? "chat.queue.deliveryUnconfirmed"
                      : "chat.queue.notSent",
              )}
            </span>
          </span>
          <SendStatusAction
            kind="retry"
            id={status().id}
            callback={retry()}
            label={action()?.label}
          />
          <SendStatusAction kind="discard" id={status().id} callback={discard()} />
        </span>
      )}
    </Show>
  );
}
