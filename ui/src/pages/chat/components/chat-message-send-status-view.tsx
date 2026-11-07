import { Show } from "solid-js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { PendingSteer } from "../chat-pending-inputs.ts";
import { describePendingSteerWait, isChatSendReconnecting } from "../chat-send-presentation.ts";
import type { readPendingSendStatus } from "../chat-thread-items.ts";

registerEnglishCatalog(registerChatComposerEnglish);
registerEnglishCatalog(registerChatSessionEnglish);

export type ChatSendStatusActions = {
  onSteerNow?: (runId: string) => void;
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
    props.status
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

export function ChatSteerNow(props: { input?: PendingSteer; onSend?: (runId: string) => void }) {
  const sendable = () => props.input?.steerNow?.status === "available" && Boolean(props.onSend);
  // Steers waiting together share one label on the newest; each keeps its own Send now.
  return (
    <Show when={(sendable() || props.input?.latest) && props.input?.steerNow}>
      {(steerNow) => (
        <div class="chat-steer-now chat-message-source">
          {sendable() ? (
            <button
              class="chat-send-status__action"
              type="button"
              onClick={() => props.onSend?.(props.input!.runId!)}
            >
              {t("chat.pendingInputs.sendNow")}
            </button>
          ) : (
            <span
              class="chat-steer-now__waiting"
              role="status"
              title={describePendingSteerWait(steerNow())}
              aria-label={describePendingSteerWait(steerNow())}
            >
              {t("chat.pendingInputs.steering")}
            </span>
          )}
        </div>
      )}
    </Show>
  );
}
