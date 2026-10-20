import { Portal, render } from "@solidjs/web";
import { registerModalSurface } from "../../../components/overlay-registry.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { getSafeLocalStorage } from "../../../local-storage.ts";

registerEnglishCatalog(registerChatMessageMetadataEnglish);

// Persisted preference key: renaming it would reset users' "Don't ask again" choice.
const SKIP_REWIND_CONFIRM_PREFERENCE = "openclaw:skip-rewind-confirm";
const CONFIRMED_ACTION_VIEWPORT_MARGIN_PX = 8;
const CONFIRMED_ACTION_TRIGGER_GAP_PX = 6;

type ConfirmedActionDismissOptions = { restoreFocus?: boolean };
const confirmedActions = new Map<
  Element,
  { popover: HTMLElement; dismiss: (options?: ConfirmedActionDismissOptions) => void }
>();

function shouldSkipRewindConfirm(): boolean {
  try {
    return getSafeLocalStorage()?.getItem(SKIP_REWIND_CONFIRM_PREFERENCE) === "1";
  } catch {
    return false;
  }
}

export function dismissConfirmedActionPopovers(owner: ParentNode): void {
  for (const [popoverOwner, { dismiss }] of confirmedActions) {
    if (owner instanceof Node && owner.contains(popoverOwner)) {
      dismiss();
    }
  }
}

export function isConfirmedActionPopoverFocused(owner: Node): boolean {
  for (const [popoverOwner, { popover }] of confirmedActions) {
    if (owner.contains(popoverOwner) && popover.contains(document.activeElement)) {
      return true;
    }
  }
  return false;
}

function resolveViewportBounds() {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;

  return {
    bottom: top + height,
    left,
    right: left + width,
    top,
  };
}

function clampConfirmedActionPosition(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function placeConfirmedActionPopover(trigger: HTMLElement, popover: HTMLElement) {
  const triggerRect = trigger.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const viewport = resolveViewportBounds();
  const margin = CONFIRMED_ACTION_VIEWPORT_MARGIN_PX;
  const gap = CONFIRMED_ACTION_TRIGGER_GAP_PX;
  const viewportWidth = viewport.right - viewport.left;
  const viewportHeight = viewport.bottom - viewport.top;
  const popoverWidth = Math.min(popoverRect.width, viewportWidth - margin * 2);
  const popoverHeight = Math.min(popoverRect.height, viewportHeight - margin * 2);
  const spaceAbove = triggerRect.top - viewport.top - margin - gap;
  const spaceBelow = viewport.bottom - triggerRect.bottom - margin - gap;
  const placeBelow = spaceAbove < popoverHeight && spaceBelow >= spaceAbove;
  const desiredLeft = triggerRect.right - popoverWidth;
  const left = clampConfirmedActionPosition(
    desiredLeft,
    viewport.left + margin,
    viewport.right - margin - popoverWidth,
  );
  const desiredTop = placeBelow ? triggerRect.bottom + gap : triggerRect.top - gap - popoverHeight;
  const top = clampConfirmedActionPosition(
    desiredTop,
    viewport.top + margin,
    viewport.bottom - margin - popoverHeight,
  );

  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
  popover.dataset.placement = placeBelow ? "below" : "above";
}

export function RewindButton(props: { onRewind: () => void }) {
  const label = () => t("chat.messages.rewind");
  return (
    <span class="chat-confirm-wrap chat-rewind-wrap">
      <openclaw-tooltip prop:content={label()}>
        <button
          class="chat-group-rewind"
          aria-label={label()}
          onClick={(event: Event) =>
            // SAFETY: This handler is registered on the native button rendered here.
            openChatRewindConfirmation(event.currentTarget as HTMLElement, () => props.onRewind())
          }
        >
          <Icon name="refresh" />
        </button>
      </openclaw-tooltip>
    </span>
  );
}

export function openChatRewindConfirmation(btn: HTMLElement, action: () => void): void {
  const confirmLabel = t("chat.messages.rewind");
  const confirmText = t("chat.messages.rewindConfirm");
  if (shouldSkipRewindConfirm()) {
    action();
    return;
  }
  const wrap = btn.closest<HTMLElement>(".chat-confirm-wrap");
  if (!wrap) {
    return;
  }
  const owner = wrap;
  const existing = confirmedActions.get(owner);
  if (existing) {
    existing.dismiss({ restoreFocus: true });
    return;
  }
  let popover!: HTMLDivElement;
  let cancel!: HTMLButtonElement;
  let yes!: HTMLButtonElement;
  let check!: HTMLInputElement;
  // Virtual rows use transforms, so portal the dialog to keep its fixed
  // coordinates relative to the viewport in web and native hosts.
  const disposePopover = render(
    () => (
      <Portal mount={owner.ownerDocument.body}>
        <div
          ref={(element) => {
            popover = element;
          }}
          class="chat-confirm-popover"
          role="dialog"
          aria-modal="true"
          aria-label={confirmText}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={containKeyboardFocus}
        >
          <p class="chat-confirm-popover__text">{confirmText}</p>
          <label class="chat-confirm-popover__remember">
            <input
              ref={(element) => {
                check = element;
              }}
              type="checkbox"
              class="chat-confirm-popover__check"
            />
            <span>{t("chat.messages.dontAskAgain")}</span>
          </label>
          <div class="chat-confirm-popover__actions">
            <button
              ref={(element) => {
                cancel = element;
              }}
              class="chat-confirm-popover__cancel"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                dismissPopover({ restoreFocus: true });
              }}
            >
              {t("common.cancel")}
            </button>
            <button
              ref={(element) => {
                yes = element;
              }}
              class="chat-confirm-popover__yes"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                if (check.checked) {
                  try {
                    getSafeLocalStorage()?.setItem(SKIP_REWIND_CONFIRM_PREFERENCE, "1");
                  } catch {}
                }
                dismissPopover();
                action();
              }}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </Portal>
    ),
    owner.ownerDocument.createDocumentFragment(),
  );
  const releaseModalSurface = registerModalSurface(popover);
  confirmedActions.set(owner, { popover, dismiss: dismissPopover });
  placeConfirmedActionPopover(btn, popover);

  let dismissed = false;
  let ownerObserver: MutationObserver | null = null;
  let stopOutsideClick: (() => void) | undefined;
  function dismissPopover(options?: ConfirmedActionDismissOptions) {
    if (dismissed) {
      return;
    }
    dismissed = true;
    releaseModalSurface();
    ownerObserver?.disconnect();
    stopOutsideClick?.();
    stopContextMenu();
    stopEscape();
    confirmedActions.delete(owner);
    disposePopover();
    if (options?.restoreFocus && btn.isConnected) {
      btn.focus({ preventScroll: true });
    }
  }
  function closeOnOutside(evt: MouseEvent) {
    const target = evt.target;
    if (
      target instanceof Node &&
      !popover.contains(target) &&
      (evt.type === "contextmenu" || !btn.contains(target))
    ) {
      dismissPopover();
    }
  }
  function closeOnEscape(evt: KeyboardEvent) {
    if (evt.key !== "Escape" || !popover.contains(document.activeElement)) {
      return;
    }
    evt.preventDefault();
    evt.stopImmediatePropagation();
    dismissPopover({ restoreFocus: true });
  }
  function containKeyboardFocus(evt: KeyboardEvent) {
    if (evt.key !== "Tab") {
      return;
    }
    const from = evt.shiftKey ? check : yes;
    const to = evt.shiftKey ? yes : check;
    if (document.activeElement === from) {
      evt.preventDefault();
      to.focus();
    }
  }
  const stopContextMenu = listen(document, "contextmenu", closeOnOutside, true);
  const stopEscape = listen(window, "keydown", closeOnEscape, true);
  ownerObserver = new MutationObserver(() => {
    if (!owner.isConnected || !btn.isConnected) {
      dismissPopover();
    }
  });
  ownerObserver.observe(owner.ownerDocument.body, { childList: true, subtree: true });
  cancel.focus({ preventScroll: true });
  requestAnimationFrame(() => {
    if (!dismissed && popover.isConnected) {
      placeConfirmedActionPopover(btn, popover);
      stopOutsideClick = listen(document, "click", closeOnOutside, true);
    }
  });
}
