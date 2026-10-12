import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
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
  const width = viewport?.width ?? window.innerWidth ?? document.documentElement.clientWidth;
  const height = viewport?.height ?? window.innerHeight ?? document.documentElement.clientHeight;

  return {
    bottom: top + height,
    left,
    right: left + width,
    top,
  };
}

function clampConfirmedActionPosition(value: number, min: number, max: number) {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
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
  const popover = document.createElement("div");
  popover.className = "chat-confirm-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-modal", "true");
  popover.setAttribute("aria-label", confirmText);
  popover.innerHTML = `
    <p class="chat-confirm-popover__text"></p>
    <label class="chat-confirm-popover__remember">
      <input type="checkbox" class="chat-confirm-popover__check" />
      <span></span>
    </label>
    <div class="chat-confirm-popover__actions">
      <button class="chat-confirm-popover__cancel" type="button"></button>
      <button class="chat-confirm-popover__yes" type="button"></button>
    </div>
  `;
  const cancel = popover.querySelector<HTMLButtonElement>(".chat-confirm-popover__cancel")!;
  const yes = popover.querySelector<HTMLButtonElement>(".chat-confirm-popover__yes")!;
  const check = popover.querySelector<HTMLInputElement>(".chat-confirm-popover__check")!;
  popover.querySelector(".chat-confirm-popover__text")!.textContent = confirmText;
  yes.textContent = confirmLabel;
  popover.querySelector(".chat-confirm-popover__remember span")!.textContent = t(
    "chat.messages.dontAskAgain",
  );
  cancel.textContent = t("common.cancel");
  // Virtual transcript rows use transforms for positioning, which makes fixed
  // descendants relative to the row instead of the viewport. Portal the dialog
  // so the viewport-clamped coordinates stay correct in web and native hosts.
  owner.ownerDocument.body.appendChild(popover);
  confirmedActions.set(owner, { popover, dismiss: dismissPopover });
  placeConfirmedActionPopover(btn, popover);

  let dismissed = false;
  let ownerObserver: MutationObserver | null = null;
  function dismissPopover(options?: ConfirmedActionDismissOptions) {
    if (dismissed) {
      return;
    }
    dismissed = true;
    ownerObserver?.disconnect();
    document.removeEventListener("click", closeOnOutside, true);
    document.removeEventListener("contextmenu", closeOnOutside, true);
    window.removeEventListener("keydown", closeOnEscape, true);
    confirmedActions.delete(owner);
    popover.remove();
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
  cancel.addEventListener("click", () => dismissPopover({ restoreFocus: true }));
  yes.addEventListener("click", () => {
    if (check.checked) {
      try {
        getSafeLocalStorage()?.setItem(SKIP_REWIND_CONFIRM_PREFERENCE, "1");
      } catch {}
    }
    dismissPopover();
    action();
  });
  // Keep this portaled dialog's clicks from dismissing its owning context menu.
  popover.addEventListener("click", (event) => event.stopPropagation());
  popover.addEventListener("keydown", containKeyboardFocus);
  document.addEventListener("contextmenu", closeOnOutside, true);
  window.addEventListener("keydown", closeOnEscape, true);
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
      document.addEventListener("click", closeOnOutside, true);
    }
  });
}
