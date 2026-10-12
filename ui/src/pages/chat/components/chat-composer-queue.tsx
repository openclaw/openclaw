import { For, createMemo, createRenderEffect, onCleanup } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import {
  chatQueueMovableSegments,
  isMovableChatQueueItem,
} from "../../../lib/chat/chat-queue-order.ts";
import type { ChatQueueItem, ChatQueueDisplayItem } from "../../../lib/chat/chat-types.ts";
import { updateHumanMentions, type HumanMentionInput } from "../../../lib/chat/human-mentions.ts";
import {
  clearCompositionEnd,
  isComposingKeyboardEvent,
  recordCompositionEnd,
} from "../../../lib/ime.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { getChatAttachmentPreviewUrl } from "../attachment-payload-store.ts";
import { isQueuedSendInlineState } from "../chat-progress.ts";
import { isSteerableQueuedMessage } from "../chat-queue.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import { hasComposerContent, solidTemplate } from "./chat-composer-controls.ts";
import { LitContent } from "./chat-composer-interop.tsx";
import type { ChatComposerProps } from "./chat-composer-types.ts";

type ChatQueueProps = {
  queue: ChatQueueItem[];
  displayQueue?: ChatQueueDisplayItem[];
  offline?: boolean;
  canAbort?: boolean;
  canRemoveServerQueued?: boolean;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
  onQueueMove?: (id: string, targetId: string) => void;
  queuedEdit?: ChatComposerProps["queuedEdit"];
  onQueueRemove: (id: string) => void;
};

/** Queue-level reorder facts: what the column shows, and what may move where. */
type ChatQueueReorder = {
  segments: readonly (readonly string[])[];
  offered: boolean;
};

const DRAG_MIME = "application/x-openclaw-queued-message";
const DRAG_OVER_CLASS = "chat-queue__item--drop-target";
const KEYBOARD_EDIT_FOCUS_ATTRIBUTE = "data-edit-keyboard-focus";
const QUEUE_ROW_CONTROL_SELECTOR =
  "a, button, input, select, textarea, wa-dropdown, wa-dropdown-item";
const QUEUE_DRAG_SCROLL_EDGE = 24;
const QUEUE_DRAG_SCROLL_MAX_SPEED = 12;
const mountedQueueEditInputs = new WeakSet<HTMLTextAreaElement>();
const queueMentionInputs = new WeakMap<HTMLTextAreaElement, HumanMentionInput>();
// The leading glyph identifies the object, not its transient delivery state.
// Row tone, badges, and actions carry failure, review, reconnect, and steer.
function QueueWaitingIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M16 5H3" />
      <path d="M16 12H3" />
      <path d="M9 19H3" />
      <path d="m16 16-3 3 3 3" />
      <path d="M21 5v12a2 2 0 0 1-2 2h-6" />
    </svg>
  );
}

let queueDragScroll: { container: HTMLElement; velocity: number; frame: number | null } | undefined;
const queueDoubleClickEditRows = new WeakSet<Element>();

function stopQueueDragAutoScroll(): void {
  if (queueDragScroll?.frame != null) {
    cancelAnimationFrame(queueDragScroll.frame);
  }
  queueDragScroll = undefined;
}

function runQueueDragAutoScroll(): void {
  const active = queueDragScroll;
  if (!active || active.velocity === 0) {
    return;
  }
  const previous = active.container.scrollTop;
  active.container.scrollTop += active.velocity;
  if (active.container.scrollTop === previous) {
    stopQueueDragAutoScroll();
    return;
  }
  active.frame = requestAnimationFrame(runQueueDragAutoScroll);
}

function updateQueueDragAutoScroll(container: HTMLElement, pointerY: number): void {
  const bounds = container.getBoundingClientRect();
  const edgeProximity = (distance: number) =>
    Math.min(QUEUE_DRAG_SCROLL_EDGE, Math.max(0, QUEUE_DRAG_SCROLL_EDGE - distance));
  const topProximity = edgeProximity(pointerY - bounds.top);
  const bottomProximity = edgeProximity(bounds.bottom - pointerY);
  const proximity = bottomProximity > 0 ? bottomProximity : -topProximity;
  const velocity = (proximity / QUEUE_DRAG_SCROLL_EDGE) * QUEUE_DRAG_SCROLL_MAX_SPEED;
  if (velocity === 0) {
    stopQueueDragAutoScroll();
    return;
  }
  if (queueDragScroll?.container === container) {
    queueDragScroll.velocity = velocity;
    if (queueDragScroll.frame == null) {
      queueDragScroll.frame = requestAnimationFrame(runQueueDragAutoScroll);
    }
    return;
  }
  stopQueueDragAutoScroll();
  queueDragScroll = {
    container,
    velocity,
    frame: requestAnimationFrame(runQueueDragAutoScroll),
  };
}

function markQueueEditFocus(row: Element | null, keyboard: boolean): void {
  row?.toggleAttribute(KEYBOARD_EDIT_FOCUS_ATTRIBUTE, keyboard);
}

function fitQueueEditInput(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  const maxHeight = Number.parseFloat(getComputedStyle(textarea).maxHeight) || 101;
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

function mountQueueEditInput(element: Element | undefined, value: string): void {
  // Seed each mounted editor once so rerenders cannot overwrite user input or selection.
  if (element instanceof HTMLTextAreaElement && !mountedQueueEditInputs.has(element)) {
    mountedQueueEditInputs.add(element);
    element.value = value;
    queueMicrotask(() => {
      if (element.isConnected) {
        fitQueueEditInput(element);
        element.focus();
        element.setSelectionRange(value.length, value.length);
      }
    });
  }
}

function sendStateLabel(item: ChatQueueItem, offline: boolean): string | null {
  if (
    offline &&
    item.sendState !== "failed" &&
    item.sendState !== "unconfirmed" &&
    item.sendState !== "held"
  ) {
    return t("chat.queue.states.waitingForReconnect");
  }
  switch (item.sendState) {
    case "waiting-model":
    case "waiting-idle":
      return null;
    case "executing-command":
      return t("chat.queue.states.runningCommand");
    case "waiting-reconnect":
      return t("chat.queue.states.waitingForReconnect");
    case "unconfirmed":
    case "held":
      return t("chat.queue.states.needsReview");
    case "failed":
      return t("common.failed");
    default:
      return null;
  }
}

export function renderChatQueueSolid(props: ChatQueueProps) {
  const visibleQueue = createMemo(() => {
    const items = (props.displayQueue ?? props.queue).filter(
      (item) =>
        item.sendState !== "submitting" &&
        item.sendState !== "sending" &&
        !isQueuedSendInlineState(item),
    );
    const edit = props.queuedEdit;
    // A retired source stays available for recovery without recreating an outbox row.
    if (
      edit?.source &&
      edit.editingId === edit.source.id &&
      !items.some((item) => item.id === edit.editingId)
    ) {
      items.push(edit.source);
    }
    return items;
  });
  const reorder = createMemo<ChatQueueReorder>(() => {
    const visibleIds = new Set(visibleQueue().map((item) => item.id));
    return {
      segments: chatQueueMovableSegments(
        props.queue,
        (item) =>
          visibleIds.has(item.id) &&
          isMovableChatQueueItem(item) &&
          item.id !== props.queuedEdit?.editingId,
      ).map((rows) => rows.map((row) => row.id)),
      offered: visibleQueue().filter(isMovableChatQueueItem).length > 1,
    };
  });
  const globalState = createMemo(() => {
    const head = props.queue.find((item) => item.sendState !== "failed" || item.localCommandName);
    return (head?.sendState === "unconfirmed" || head?.sendState === "held") &&
      isQueuedSendInlineState(head)
      ? { label: t("chat.queue.states.blockedByUnconfirmed"), tone: "warn" }
      : visibleQueue().some((item) => item.sendState === "waiting-model") && !props.offline
        ? { label: t("chat.queue.states.applyingSettings"), tone: "settings" }
        : null;
  });
  let scrollRegion: HTMLDivElement | undefined;
  onCleanup(() => {
    if (queueDragScroll?.container === scrollRegion) {
      stopQueueDragAutoScroll();
    }
  });
  return (
    <>
      {visibleQueue().length > 0 ? (
        <div class="chat-queue" role="status" aria-live="polite">
          {globalState() ? (
            <div
              class="chat-queue__global-state"
              data-chat-queue-global-state={globalState()!.tone}
            >
              {globalState()!.label}
            </div>
          ) : null}
          <div
            class="chat-queue__scroll"
            ref={(element) => {
              scrollRegion = element;
            }}
            data-scrollable={visibleQueue().length > 3 ? "true" : "false"}
            data-at-start="true"
            data-at-end={visibleQueue().length > 3 ? "false" : "true"}
            onDragOver={(event: DragEvent) => {
              if (
                event.dataTransfer?.types.includes(DRAG_MIME) &&
                event.currentTarget instanceof HTMLElement
              ) {
                updateQueueDragAutoScroll(event.currentTarget, event.clientY);
              }
            }}
            onDragLeave={(event: DragEvent) => {
              if (
                event.currentTarget instanceof HTMLElement &&
                event.relatedTarget instanceof Node &&
                event.currentTarget.contains(event.relatedTarget)
              ) {
                return;
              }
              stopQueueDragAutoScroll();
            }}
            onDrop={stopQueueDragAutoScroll}
            onScroll={(event: Event) => {
              const scroll = event.currentTarget;
              if (scroll instanceof HTMLElement) {
                scroll.dataset.atStart = String(scroll.scrollTop <= 1);
                scroll.dataset.atEnd = String(
                  scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1,
                );
              }
            }}
          >
            <For each={visibleQueue()} keyed={(item) => item.id}>
              {(item) => <ChatQueueItem item={item()} controls={props} reorder={reorder()} />}
            </For>
          </div>
        </div>
      ) : null}
    </>
  );
}

function setDropTarget(event: DragEvent, active: boolean): void {
  const row = event.currentTarget;
  if (row instanceof HTMLElement) {
    row.classList.toggle(DRAG_OVER_CLASS, active);
  }
}

function ChatQueueItem(rowProps: {
  item: ChatQueueDisplayItem;
  controls: ChatQueueProps;
  reorder: ChatQueueReorder;
}) {
  const item = () => rowProps.item;
  const reorder = () => rowProps.reorder;
  const edit = createMemo(() => rowProps.controls.queuedEdit);
  const authorAvatar = createMemo(() => renderChatAuthorAvatar(item().sender));
  const hasAuthorAvatar = createMemo(() => hasComposerContent(authorAvatar()));
  const images = createMemo(() =>
    item().attachments?.filter((attachment) => attachment.mimeType.startsWith("image/")),
  );
  const previewUrl = createMemo(() => {
    const image = images()?.[0];
    return image ? getChatAttachmentPreviewUrl(image) : null;
  });
  const failed = createMemo(
    () =>
      item().sendState === "failed" ||
      item().sendState === "unconfirmed" ||
      item().sendState === "held",
  );
  const reconnecting = createMemo(
    () =>
      !item().serverQueued &&
      !failed() &&
      (rowProps.controls.offline || item().sendState === "waiting-reconnect"),
  );
  const stateLabel = createMemo(() =>
    sendStateLabel(item(), !item().serverQueued && rowProps.controls.offline === true),
  );
  const steered = createMemo(() => item().queueMode === "steer" && stateLabel() === null);
  const busy = createMemo(() => item().sendState === "executing-command");
  const editing = createMemo(() => edit()?.editingId === item().id);
  let editInput: HTMLTextAreaElement | undefined;
  createRenderEffect(
    () => (editing() ? (edit()?.editingText ?? item().text) : undefined),
    (value) => {
      // Recovery may publish its draft after the editor mounts. Native input already matches.
      if (editInput && value !== undefined && editInput.value !== value) {
        editInput.value = value;
        fitQueueEditInput(editInput);
      }
    },
  );
  const mentionText = createMemo(() =>
    editing() ? (edit()?.editingText ?? item().text) : item().text,
  );
  const mentions = createMemo(() => (editing() ? edit()?.editingMentions : item().mentions));
  const canSteer = createMemo(
    () =>
      Boolean(rowProps.controls.canAbort && rowProps.controls.onQueueSteer) &&
      isSteerableQueuedMessage(item()) &&
      !editing(),
  );
  const showsSteer = createMemo(
    () =>
      Boolean(rowProps.controls.canAbort && rowProps.controls.onQueueSteer) &&
      !editing() &&
      !item().localCommandName &&
      !item().intent &&
      (isSteerableQueuedMessage(item()) || item().sendState === "waiting-model"),
  );
  const segment = createMemo(() => reorder().segments.find((ids) => ids.includes(item().id)) ?? []);
  const moveIndex = createMemo(() => segment().indexOf(item().id));
  const move = createMemo(() => rowProps.controls.onQueueMove);
  // Queue-level: once any row can move, every row's own state icon becomes the
  // handle so text stays on one x without adding a second grabber column.
  const showsHandle = createMemo(() => Boolean(move()) && reorder().offered);
  const canMove = createMemo(() => showsHandle() && moveIndex() >= 0 && segment().length > 1);
  // Every row keeps its handle and action slots in every state and goes inert
  // instead of empty while an edit is open, so no column moves mid-flow.
  const editable = createMemo(
    () => Boolean(edit()?.onEdit) && isMovableChatQueueItem(item()) && !item().localCommandName,
  );
  const canEdit = createMemo(() => editable() && !edit()?.editingId);
  const text = createMemo(
    () =>
      item().text ||
      (item().attachments?.length
        ? t("chat.queue.imageCount", { count: String(item().attachments?.length ?? 0) })
        : ""),
  );
  const itemClass = createMemo(
    () =>
      `chat-queue__item${hasAuthorAvatar() ? "" : " chat-queue__item--no-avatar"}${previewUrl() ? " chat-queue__item--with-images" : ""}${steered() ? " chat-queue__item--steered" : ""}${
        failed() ? " chat-queue__item--failed" : ""
      }${reconnecting() ? " chat-queue__item--reconnect" : ""}${
        editing() ? " chat-queue__item--editing" : ""
      }`,
  );
  const renderDeliveryAction = (action: "retry" | "steer", disabled = false) => (
    <button
      class={`chat-queue__action chat-queue__${action}`}
      type="button"
      disabled={disabled}
      aria-label={t(`chat.queue.${action}QueuedMessage`)}
      onClick={() =>
        action === "retry"
          ? rowProps.controls.onQueueRetry?.(item().id)
          : rowProps.controls.onQueueSteer?.(item().id)
      }
    >
      {action === "retry" ? <Icon name="refresh" /> : <Icon name="arrowUp" />}
      <span>{t(`chat.queue.${action}`)}</span>
    </button>
  );
  // The error occupies the grid's final columns below the primary row, so a
  // diagnostic grows the attached tray without disturbing its action rail.
  return (
    <div
      class={itemClass()}
      data-chat-queue-item={item().id}
      onClick={(event: MouseEvent) => {
        const row = event.currentTarget;
        const target = event.target;
        if (!(row instanceof Element) || !(target instanceof Element)) {
          return;
        }
        if (!canEdit() || target.closest(QUEUE_ROW_CONTROL_SELECTOR)) {
          queueDoubleClickEditRows.delete(row);
        } else if (event.detail === 1) {
          queueDoubleClickEditRows.add(row);
        }
      }}
      onDblClick={(event: MouseEvent) => {
        const row = event.currentTarget;
        if (!canEdit() || !(row instanceof Element) || !queueDoubleClickEditRows.has(row)) {
          return;
        }
        queueDoubleClickEditRows.delete(row);
        event.stopPropagation();
        markQueueEditFocus(row, false);
        edit()?.onEdit?.(item().id);
      }}
      onDragOver={(event: DragEvent) => {
        if (!canMove() || !event.dataTransfer?.types.includes(DRAG_MIME)) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropTarget(event, true);
      }}
      onDragLeave={(event: DragEvent) => {
        if (canMove()) {
          setDropTarget(event, false);
        }
      }}
      onDrop={(event: DragEvent) => {
        if (!canMove()) {
          return;
        }
        const draggedId = event.dataTransfer?.getData(DRAG_MIME);
        setDropTarget(event, false);
        // A drop cannot cross a hidden delivery barrier.
        if (!draggedId || draggedId === item().id || !segment().includes(draggedId)) {
          return;
        }
        event.preventDefault();
        move()?.(draggedId, item().id);
      }}
    >
      {showsHandle() ? (
        <button
          class="chat-queue__leading chat-queue__grip"
          type="button"
          draggable={canMove() ? "true" : "false"}
          disabled={!canMove()}
          aria-label={
            canMove() ? t("chat.queue.reorderQueuedMessage") : t("chat.queue.reorderUnavailable")
          }
          aria-keyshortcuts={canMove() ? "ArrowUp ArrowDown" : undefined}
          onDragStart={(event: DragEvent) => {
            if (!canMove()) {
              return;
            }
            event.dataTransfer?.setData(DRAG_MIME, item().id);
            if (event.dataTransfer) {
              event.dataTransfer.effectAllowed = "move";
            }
          }}
          onDragEnd={stopQueueDragAutoScroll}
          onKeyDown={(event: KeyboardEvent) => {
            if (!canMove()) {
              return;
            }
            const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
            if (delta === 0) {
              return;
            }
            // The handle owns reordering for pointer and keyboard alike, so
            // arrow keys here must not also scroll the transcript.
            event.preventDefault();
            const targetId = segment()[moveIndex() + delta];
            if (targetId) {
              const handle = event.currentTarget;
              move()?.(item().id, targetId);
              // A keyed DOM move can blur its focused descendant. Preserve the
              // same handle for repeated arrow presses after the queued commit.
              queueMicrotask(() => {
                if (
                  handle instanceof HTMLButtonElement &&
                  handle.isConnected &&
                  !handle.disabled &&
                  handle.ownerDocument.activeElement === handle.ownerDocument.body
                ) {
                  handle.focus({ preventScroll: true });
                }
              });
            }
          }}
        >
          <span class="chat-queue__grip-state chat-queue__grip-state--idle" aria-hidden="true">
            <QueueWaitingIcon />
          </span>
          {canMove() ? (
            <span class="chat-queue__grip-state chat-queue__grip-state--active" aria-hidden="true">
              <Icon name="gripVertical" />
            </span>
          ) : null}
        </button>
      ) : (
        <span class="chat-queue__leading chat-queue__icon" aria-hidden="true">
          <QueueWaitingIcon />
        </span>
      )}
      <LitContent value={authorAvatar()} />
      {previewUrl() && images() ? (
        <img
          class="chat-queue__images"
          src={previewUrl() ?? undefined}
          alt={t("chat.queue.imageCount", { count: String(images()?.length ?? 0) })}
          draggable="false"
          width="24"
          height="24"
          loading="lazy"
          decoding="async"
        />
      ) : null}
      {editing() ? (
        <textarea
          class="chat-queue__edit-input"
          rows="1"
          ref={(element) => {
            editInput = element;
            mountQueueEditInput(element, edit()?.editingText ?? item().text);
          }}
          aria-label={t("chat.queue.editQueuedMessage")}
          onBeforeInput={(event: InputEvent) => {
            if (event.currentTarget instanceof HTMLTextAreaElement) {
              queueMentionInputs.set(event.currentTarget, {
                value: event.currentTarget.value,
                start: event.currentTarget.selectionStart,
                end: event.currentTarget.selectionEnd,
                inputType: event.inputType,
              });
            }
          }}
          onInput={(event: Event) => {
            if (event.currentTarget instanceof HTMLTextAreaElement) {
              const textarea = event.currentTarget;
              fitQueueEditInput(textarea);
              const currentMentions = mentions();
              if (currentMentions?.length) {
                edit()?.onEditChange?.(
                  textarea.value,
                  updateHumanMentions(
                    mentionText(),
                    textarea.value,
                    currentMentions,
                    queueMentionInputs.get(textarea),
                  ),
                );
              } else {
                edit()?.onEditChange?.(textarea.value);
              }
              queueMentionInputs.delete(textarea);
            }
          }}
          onKeyDown={(event: KeyboardEvent) => {
            if (isComposingKeyboardEvent(event)) {
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              edit()?.onCancel();
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              edit()?.onEditSubmit?.();
            }
          }}
          onCompositionEnd={recordCompositionEnd}
          onKeyUp={clearCompositionEnd}
          onBlur={clearCompositionEnd}
        />
      ) : (
        <span class="chat-queue__copy">
          <span class="chat-queue__text" title={text()}>
            {text()}
          </span>
          {steered() && !canSteer() ? (
            <span class="chat-queue__badge chat-queue__badge--steered">
              {t("chat.queue.steer")}
            </span>
          ) : null}
          {stateLabel() && (!failed() || !item().sendError) ? (
            <span
              class={
                failed()
                  ? "chat-queue__badge"
                  : reconnecting()
                    ? "chat-queue__badge chat-queue__badge--reconnect"
                    : "chat-queue__state"
              }
              title={reconnecting() ? item().sendError : undefined}
            >
              {stateLabel()}
            </span>
          ) : null}
        </span>
      )}
      <span class="chat-queue__actions">
        {failed() && !editing() && rowProps.controls.onQueueRetry
          ? renderDeliveryAction("retry")
          : null}
        {showsSteer() ? renderDeliveryAction("steer", !canSteer()) : null}
        {editing() ? (
          <>
            <button
              class="chat-queue__edit-submit"
              type="button"
              aria-label={t("chat.runControls.sendMessage")}
              onClick={() => edit()?.onEditSubmit?.()}
            >
              <Icon name="check" />
            </button>
            <button
              class="chat-queue__edit-cancel"
              type="button"
              aria-label={t("chat.queue.cancelEdit")}
              onClick={() => edit()?.onCancel()}
            >
              <Icon name="x" />
            </button>
          </>
        ) : null}
        {busy() || editing() ? null : (
          <openclaw-tooltip prop:content={t("chat.queue.removeQueuedMessage")}>
            <button
              class="chat-queue__remove"
              type="button"
              disabled={item().serverQueued && !rowProps.controls.canRemoveServerQueued}
              aria-label={t("chat.queue.removeQueuedMessage")}
              onClick={(event: MouseEvent) => {
                // Chromium retargets click 2 after row removal; detail still owns the gesture.
                if (event.detail <= 1) {
                  rowProps.controls.onQueueRemove(item().id);
                }
              }}
              onDblClick={(event: MouseEvent) => event.stopPropagation()}
            >
              <Icon name="trash" />
            </button>
          </openclaw-tooltip>
        )}
        {editing() || !editable() ? null : (
          <wa-dropdown
            class="chat-queue__overflow"
            placement="top-end"
            onWa-select={(event: CustomEvent<{ item: Element & { value?: string } }>) => {
              const selectedItem = event.detail.item;
              if (selectedItem.value === "edit" && canEdit()) {
                const dropdown = event.currentTarget;
                const row =
                  dropdown instanceof Element ? dropdown.closest(".chat-queue__item") : null;
                const keyboard = selectedItem.matches(":focus-visible");
                markQueueEditFocus(row, keyboard);
                edit()?.onEdit?.(item().id);
              }
            }}
          >
            <button
              slot="trigger"
              class="chat-queue__more"
              type="button"
              disabled={!canEdit()}
              aria-label={t("chat.queue.moreActions")}
              onDblClick={(event: MouseEvent) => event.stopPropagation()}
            >
              <Icon name="moreHorizontal" />
            </button>
            <wa-dropdown-item value="edit" disabled={!canEdit()}>
              <span slot="icon" aria-hidden="true">
                <Icon name="pencil" />
              </span>
              {t("chat.queue.editQueuedMessage")}
            </wa-dropdown-item>
          </wa-dropdown>
        )}
      </span>
      {mentions()?.length ? (
        <span class="chat-queue__mentions">
          {t("chat.mentions.selected", {
            names: (mentions() ?? [])
              .map(({ start, end }) => mentionText().slice(start, end))
              .join(", "),
          })}
          {editing() ? (
            <button
              class="chat-queue__remove"
              type="button"
              aria-label={t("chat.mentions.remove")}
              onClick={() => edit()?.onEditChange?.(mentionText(), [])}
            >
              <Icon name="x" />
            </button>
          ) : null}
        </span>
      ) : null}
      {item().sendError && !reconnecting() ? (
        <span class="chat-queue__error">
          {failed() && stateLabel() ? <span class="chat-queue__badge">{stateLabel()}</span> : null}
          <span class="chat-queue__error-text">{item().sendError}</span>
        </span>
      ) : null}
    </div>
  );
}

export function renderChatQueue(props: ChatQueueProps) {
  return solidTemplate(renderChatQueueSolid, props);
}
