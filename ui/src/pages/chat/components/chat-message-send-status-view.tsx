import { Show } from "solid-js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { isChatSendReconnecting } from "../chat-send-presentation.ts";
import type { readPendingSendStatus } from "../chat-thread-items.ts";

registerEnglishCatalog(registerChatComposerEnglish);

export type ChatSendStatusActions = {
  connected?: boolean;
  onRetryQueuedMessage?: (id: string) => void;
  onDiscardQueuedMessage?: (id: string) => void;
  queuedMessageAction?: {
    id: string;
    label?: string;
    onAction?: () => void;
    onDiscard?: () => void;
  };
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
          class={["chat-send-status__action", `chat-send-status__${props.kind}`]}
          type="button"
          aria-label={
            props.kind === "retry" ? (props.label ?? t("chat.queue.retryQueuedMessage")) : undefined
          }
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

export function ChatSendStatus(props: { status: SendStatus; actions: ChatSendStatusActions }) {
  const action = () =>
    props.actions.queuedMessageAction?.id === props.status?.id
      ? props.actions.queuedMessageAction
      : undefined;
  const pending = () =>
    props.status && props.status.state !== "failed" && props.status.state !== "held";
  const reconnecting = () => isChatSendReconnecting(props.status?.state, props.actions.connected);
  const retry = () =>
    pending() ? undefined : (action()?.onAction ?? props.actions.onRetryQueuedMessage);
  const discard = () =>
    props.status && !pending()
      ? action()
        ? action()?.onDiscard
        : props.actions.onDiscardQueuedMessage
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
