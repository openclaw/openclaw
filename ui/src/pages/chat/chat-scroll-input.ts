import { isApplePlatform } from "../../lib/keyboard-shortcut-contract.ts";

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export function forwardChatWheelToTranscript(
  event: WheelEvent,
  transcript: HTMLElement | null,
): void {
  if (
    !transcript ||
    event.defaultPrevented ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey ||
    !event.deltaY ||
    Math.abs(event.deltaX) > Math.abs(event.deltaY)
  ) {
    return;
  }
  const path = event.composedPath();
  if (path.includes(transcript)) {
    return;
  }
  for (const target of path) {
    if (target === event.currentTarget) {
      break;
    }
    if (!(target instanceof HTMLElement)) {
      continue;
    }
    const style = getComputedStyle(target);
    const contextCanScroll =
      event.deltaY < 0
        ? target.scrollTop > 0
        : target.scrollTop + target.clientHeight < target.scrollHeight - 1;
    if (
      /^(auto|scroll)$/.test(style.overflowY) &&
      ((target.scrollHeight > target.clientHeight &&
        (!target.closest(".chat-footer__context") || contextCanScroll)) ||
        style.overscrollBehaviorY === "contain" ||
        style.overscrollBehaviorY === "none")
    ) {
      return;
    }
  }

  // Deliver intent to the existing history and reader-takeover owners before
  // moving: setting scrollTop alone leaves queued follow/reveal work active.
  const forwarded = new WheelEvent("wheel", {
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaMode: event.deltaMode,
    cancelable: true,
  });
  if (!transcript.dispatchEvent(forwarded)) {
    return;
  }
  event.preventDefault();
  const style = getComputedStyle(transcript);
  const unit =
    event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? transcript.clientHeight
      : event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2
        : 1;
  transcript.scrollBy({ top: event.deltaY * unit, behavior: "instant" });
}

/** Native wheel intent belongs to the transcript only after nested scrollports yield. */
export function isTranscriptScrollWheel(event: WheelEvent, transcript: HTMLElement): boolean {
  if (
    event.defaultPrevented ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey ||
    !event.deltaY ||
    Math.abs(event.deltaX) > Math.abs(event.deltaY)
  ) {
    return false;
  }
  for (const target of event.composedPath()) {
    if (target === transcript) {
      break;
    }
    if (!(target instanceof HTMLElement)) {
      continue;
    }
    const style = getComputedStyle(target);
    if (
      /^(auto|scroll)$/.test(style.overflowY) &&
      ((event.deltaY < 0
        ? target.scrollTop > 0
        : target.scrollTop < target.scrollHeight - target.clientHeight) ||
        style.overscrollBehaviorY === "contain" ||
        style.overscrollBehaviorY === "none")
    ) {
      return false;
    }
  }
  return true;
}

export function isTranscriptScrollKey(event: KeyboardEvent, transcript: HTMLElement): boolean {
  if (event.defaultPrevented || !SCROLL_KEYS.has(event.key)) {
    return false;
  }
  const editingKey = event.key === " " || event.key === "ArrowUp" || event.key === "ArrowDown";
  const pagingKey = !editingKey && !event.shiftKey && !event.altKey && !event.metaKey;
  const applePlatform = isApplePlatform();
  // macOS forwards plain paging to scrolling; native caret/selection bindings
  // must not interrupt restoration. Single-line PageUp/Down also bubble elsewhere.
  const nativePaging = pagingKey && !event.ctrlKey && applePlatform;
  const upward =
    event.key === "ArrowUp" ||
    event.key === "PageUp" ||
    event.key === "Home" ||
    (event.key === " " && event.shiftKey);
  let editabilityResolved = false;
  // Inspect the composed path so native controls inside shadow roots keep
  // their navigation keys without cancelling transcript restoration or follow.
  for (const target of event.composedPath()) {
    // Solid's delegated handlers can leave currentTarget naming a nested node.
    // The transcript owner supplies the native scroll boundary explicitly.
    if (target === transcript) {
      break;
    }
    if (!(target instanceof HTMLElement)) {
      continue;
    }
    // Native media handles playback, volume, and seeking without preventDefault;
    // only PageUp/Down on the host yield to transcript scrolling.
    if (target instanceof HTMLMediaElement && target.controls && !event.key.startsWith("Page")) {
      return false;
    }
    if (target instanceof HTMLInputElement) {
      if (target.type === "range") {
        if (event.key !== " ") {
          return false;
        }
      } else if (
        ["button", "checkbox", "color", "file", "image", "reset", "submit"].includes(target.type)
      ) {
        if (event.key === " ") {
          return false;
        }
      } else if (!nativePaging && !(pagingKey && !event.ctrlKey && event.key.startsWith("Page"))) {
        return false;
      }
    }
    if (
      target instanceof HTMLSelectElement &&
      (target.multiple ||
        target.size > 1 ||
        (!nativePaging &&
          !(pagingKey && event.ctrlKey && !applePlatform && !event.key.startsWith("Page"))))
    ) {
      return false;
    }
    if (target instanceof HTMLTextAreaElement && !nativePaging) {
      return false;
    }
    if (!editabilityResolved && target.hasAttribute("contenteditable")) {
      editabilityResolved = true;
      if (!target.matches('[contenteditable="false" i]') && !nativePaging) {
        return false;
      }
    }
    if (event.key === " " && target.matches("button, summary")) {
      return false;
    }
    // Native paging chains at a nested edge only when overscroll permits it.
    // Contained keys must not cancel transcript restoration or following.
    const style = getComputedStyle(target);
    if (
      /^(auto|scroll)$/.test(style.overflowY) &&
      ((upward
        ? target.scrollTop > 0
        : target.scrollTop < target.scrollHeight - target.clientHeight) ||
        style.overscrollBehaviorY === "contain" ||
        style.overscrollBehaviorY === "none")
    ) {
      return false;
    }
  }
  return true;
}

const HISTORY_TOUCH_INTENT_PX = 8;
const HISTORY_UPWARD_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
const HISTORY_DOWNWARD_KEYS = new Set(["ArrowDown", "PageDown", "End"]);

/** Nested/native controls own their gesture before transcript boundary paging. */
function ownsTranscriptGesture(event: Event, direction: number, transcript: HTMLElement): boolean {
  if (event.defaultPrevented) {
    return false;
  }
  for (const target of event.composedPath()) {
    if (target === transcript) {
      break;
    }
    if (!(target instanceof HTMLElement)) {
      continue;
    }
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLMediaElement && target.controls)
    ) {
      return false;
    }
    const style = getComputedStyle(target);
    const canScroll =
      direction < 0
        ? target.scrollTop > 0
        : target.scrollTop < target.scrollHeight - target.clientHeight;
    if (
      /^(auto|scroll)$/.test(style.overflowY) &&
      (canScroll || style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none")
    ) {
      return false;
    }
  }
  return true;
}

export class TranscriptHistoryInput {
  private touchY: number | null = null;

  reset(): void {
    this.touchY = null;
  }

  readBoundaryDirection(event: Event, margin: number, transcript: HTMLElement | null): -1 | 0 | 1 {
    const direction = this.readDirection(event, transcript);
    if (transcript === null || direction === 0) {
      return 0;
    }
    const distance =
      direction < 0
        ? transcript.scrollTop
        : transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop;
    return distance <= margin ? direction : 0;
  }

  private readDirection(event: Event, transcript: HTMLElement | null): -1 | 0 | 1 {
    if (event instanceof WheelEvent) {
      if (
        transcript === null ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        !event.deltaY ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
        !ownsTranscriptGesture(event, event.deltaY, transcript)
      ) {
        return 0;
      }
      return event.deltaY < 0 ? -1 : 1;
    }
    if (
      event instanceof KeyboardEvent &&
      transcript !== null &&
      isTranscriptScrollKey(event, transcript)
    ) {
      if (HISTORY_UPWARD_KEYS.has(event.key) || (event.key === " " && event.shiftKey)) {
        return -1;
      }
      return HISTORY_DOWNWARD_KEYS.has(event.key) || event.key === " " ? 1 : 0;
    }
    if (typeof TouchEvent !== "undefined" && event instanceof TouchEvent) {
      const touchY = event.touches.length === 1 ? (event.touches[0]?.clientY ?? null) : null;
      if (event.type === "touchstart") {
        this.touchY = touchY;
        return 0;
      }
      if (event.type === "touchend" || event.type === "touchcancel" || touchY === null) {
        this.touchY = null;
        return 0;
      }
      const previousTouchY = this.touchY;
      if (previousTouchY !== null && Math.abs(touchY - previousTouchY) >= HISTORY_TOUCH_INTENT_PX) {
        this.touchY = touchY;
        const direction = touchY > previousTouchY ? -1 : 1;
        return transcript !== null && ownsTranscriptGesture(event, direction, transcript)
          ? direction
          : 0;
      }
    }
    return 0;
  }
}
