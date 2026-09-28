import { captureChatSessionScrollPosition } from "../scroll.ts";
import { publishTranscriptScroll } from "./chat-transcript-scroll-events.ts";

const COMPOSER_CHROME_INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "wa-dropdown",
  "[contenteditable='true']",
  "[role='button']",
  "[role='listbox']",
  "[role='option']",
].join(",");

type ComposerTextareaResizeObserverState = {
  observer: ResizeObserver | null;
  adjustmentFrame: number | null;
  overflowFrame: number | null;
  height: number;
  nativeInputPending: boolean;
  hasScrollbarGutter: boolean;
  editing: boolean;
  events: AbortController;
};

type ComposerPopoverAnchorObserverState = {
  resizeObserver: ResizeObserver | null;
  toggleObserver: MutationObserver | null;
  viewport: VisualViewport | null;
  updateFrame: number | null;
  scheduleUpdate: () => void;
};

const composerTextareaResizeObservers = new WeakMap<
  HTMLTextAreaElement,
  ComposerTextareaResizeObserverState
>();
const composerPopoverAnchorObservers = new WeakMap<
  HTMLElement,
  ComposerPopoverAnchorObserverState
>();

// max-height constrains the menu's scrollable box before its border/padding;
// include that chrome so the outer panel retains a viewport gutter.
const COMPOSER_POPOVER_VIEWPORT_INSET_PX = 28;

function hasNativeTextareaContentSizing(el: HTMLTextAreaElement) {
  return (
    el.matches(".agent-chat__composer-combobox > textarea") &&
    typeof CSS !== "undefined" &&
    CSS.supports("field-sizing", "content")
  );
}

function updateComposerPopoverAnchor(el: HTMLElement) {
  const viewport = window.visualViewport;
  const viewportTop = viewport?.offsetTop ?? 0;
  const composerTop = el.getBoundingClientRect().top;
  const maxHeight = composerTop - viewportTop - COMPOSER_POPOVER_VIEWPORT_INSET_PX;
  el.style.setProperty("--chat-composer-popover-max-height", `${Math.max(0, maxHeight)}px`);
}

function observeComposerPopoverAnchor(el: HTMLElement) {
  if (composerPopoverAnchorObservers.has(el)) {
    return;
  }
  const viewport = window.visualViewport;
  const state: ComposerPopoverAnchorObserverState = {
    resizeObserver: null,
    toggleObserver: null,
    viewport,
    updateFrame: null,
    scheduleUpdate: () => {
      if (state.updateFrame !== null) {
        return;
      }
      state.updateFrame = requestAnimationFrame(() => {
        state.updateFrame = null;
        if (composerPopoverAnchorObservers.get(el) === state) {
          updateComposerPopoverAnchor(el);
        }
      });
    },
  };
  if (typeof ResizeObserver === "function") {
    state.resizeObserver = new ResizeObserver(state.scheduleUpdate);
    state.resizeObserver.observe(el);
  }
  if (typeof MutationObserver === "function") {
    state.toggleObserver = new MutationObserver(state.scheduleUpdate);
    state.toggleObserver.observe(el, {
      attributes: true,
      attributeFilter: ["open"],
      subtree: true,
    });
  }
  window.addEventListener("resize", state.scheduleUpdate);
  viewport?.addEventListener("resize", state.scheduleUpdate);
  viewport?.addEventListener("scroll", state.scheduleUpdate);
  composerPopoverAnchorObservers.set(el, state);
  updateComposerPopoverAnchor(el);
}

export function disconnectComposerPopoverAnchorObserver(el: HTMLElement) {
  const state = composerPopoverAnchorObservers.get(el);
  composerPopoverAnchorObservers.delete(el);
  if (!state) {
    return;
  }
  state.resizeObserver?.disconnect();
  state.toggleObserver?.disconnect();
  window.removeEventListener("resize", state.scheduleUpdate);
  state.viewport?.removeEventListener("resize", state.scheduleUpdate);
  state.viewport?.removeEventListener("scroll", state.scheduleUpdate);
  if (state.updateFrame !== null) {
    cancelAnimationFrame(state.updateFrame);
  }
}

export function replaceComposerPopoverAnchor(
  previous: HTMLElement | null,
  element?: Element,
): HTMLElement | null {
  const next = element instanceof HTMLElement ? element : null;
  if (previous && previous !== next) {
    disconnectComposerPopoverAnchorObserver(previous);
  }
  if (next) {
    observeComposerPopoverAnchor(next);
  }
  return next;
}

function invalidateNativeTextareaLayout(
  el: HTMLTextAreaElement,
  state: ComposerTextareaResizeObserverState,
) {
  state.nativeInputPending = true;
  const thread = el.closest(".chat")?.querySelector<HTMLElement>(".chat-thread");
  if (thread) {
    publishTranscriptScroll(thread, { type: "composer-input" });
  }
  // A classic scrollbar can keep the intrinsic height capped by narrowing the
  // draft. Use the last settled gutter, not an input-time layout measurement.
  if (state.hasScrollbarGutter && el.style.overflowY !== "hidden") {
    el.style.overflowY = "hidden";
  }
}

function scheduleNativeTextareaOverflow(el: HTMLTextAreaElement) {
  el.removeAttribute("data-scroll-fade-top");
  el.removeAttribute("data-scroll-fade-bottom");
  const state = composerTextareaResizeObservers.get(el);
  if (!state || state.overflowFrame !== null) {
    return;
  }
  state.overflowFrame = requestAnimationFrame(() => {
    state.overflowFrame = null;
    if (el.isConnected && composerTextareaResizeObservers.get(el) === state) {
      updateTextareaOverflow(el, false);
    }
  });
}

function updateTextareaOverflow(
  el: HTMLTextAreaElement,
  deferNativeEditing = true,
  measured?: { scrollHeight: number; clientHeight: number },
) {
  if (
    deferNativeEditing &&
    composerTextareaResizeObservers.get(el)?.editing &&
    hasNativeTextareaContentSizing(el)
  ) {
    // Clear the caret mask before native scrolling, but measure overflow only
    // after the edit. Browser support alone says nothing about sibling fields.
    scheduleNativeTextareaOverflow(el);
    return;
  }
  const clientHeight = measured?.clientHeight ?? el.clientHeight;
  const scrollHeight = measured?.scrollHeight ?? el.scrollHeight;
  const scrollable = scrollHeight > clientHeight + 1;
  // Two 16px fades need enough vertical runway not to overlap into a narrow
  // opaque strip on short drafts. Small overflows still scroll, just unfaded.
  const canFade =
    scrollable && clientHeight >= 64 && !composerTextareaResizeObservers.get(el)?.editing;
  const fadeTop = canFade && el.scrollTop > 1;
  const fadeBottom = canFade && el.scrollTop + clientHeight < scrollHeight - 1;
  const overflow = scrollable ? "auto" : "hidden";
  if (el.style.overflowY !== overflow) {
    el.style.overflowY = overflow;
  }
  el.toggleAttribute("data-scroll-fade-top", fadeTop);
  el.toggleAttribute("data-scroll-fade-bottom", fadeBottom);
  const state = composerTextareaResizeObservers.get(el);
  if (state) {
    state.hasScrollbarGutter = false;
    if (scrollable && hasNativeTextareaContentSizing(el)) {
      const style = getComputedStyle(el);
      state.hasScrollbarGutter =
        el.offsetWidth - el.clientWidth >
        Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
    }
    const changed = state.height !== clientHeight;
    state.height = clientHeight;
    if (state.nativeInputPending) {
      state.nativeInputPending = false;
      const thread = el.closest(".chat")?.querySelector<HTMLElement>(".chat-thread");
      if (thread) {
        publishTranscriptScroll(thread, { type: "composer-layout", changed });
      }
    }
  }
}

export function adjustTextareaHeight(
  el: HTMLTextAreaElement,
  options: { nativeInput?: boolean } = {},
) {
  // A surface that declares the compact shape is a fixed CSS box: it holds one
  // line whatever the draft is, so an inline height left by an earlier measured
  // pass would silently outrank the stylesheet. Which shape a composer is in is
  // declared in its markup, never inferred here from how much text it holds.
  if (el.closest('[data-composer-layout="single-line"]')) {
    el.style.height = "";
    el.style.overflowY = "";
    el.removeAttribute("data-scroll-fade-top");
    el.removeAttribute("data-scroll-fade-bottom");
    return;
  }
  // Modern engines can size the textarea from its content in the normal layout
  // pass. Do not force repeated transcript and textarea layout reads on every
  // keystroke when that native path is available.
  const thread = el.closest(".chat")?.querySelector<HTMLElement>(".chat-thread") ?? null;
  const state = composerTextareaResizeObservers.get(el);
  if (options.nativeInput && state && hasNativeTextareaContentSizing(el)) {
    invalidateNativeTextareaLayout(el, state);
    if (el.style.height !== "") {
      el.style.height = "";
    }
    scheduleNativeTextareaOverflow(el);
    return;
  }
  if (thread) {
    // A measured structural transition can replace the native edit before its
    // observer fires. Commit that geometry through the transcript owner first.
    publishTranscriptScroll(thread, { type: "before-resize" });
  }
  const threadHeight = thread?.clientHeight;
  const scrollPosition = thread ? captureChatSessionScrollPosition(thread) : null;
  // The owning surface declares its cap in CSS. Retain the historical fallback
  // for detached/test controls whose computed max-height is not a pixel value.
  const style = getComputedStyle(el);
  const computedMaxHeight = style.maxHeight.trim();
  const pixelMaxHeight = /^(\d+(?:\.\d+)?)px$/u.exec(computedMaxHeight);
  const maxHeight = pixelMaxHeight ? Number(pixelMaxHeight[1]) : 150;
  const borderBox = style.boxSizing === "border-box";
  const naturalHeight =
    Number.parseFloat(style.lineHeight) * el.rows +
    (borderBox ? Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) : 0);
  const minHeight = Math.max(
    Number.parseFloat(style.minHeight),
    Math.round(naturalHeight) +
      (borderBox
        ? Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)
        : 0),
  );
  const assignedHeight = /^(\d+(?:\.\d+)?)px$/u.exec(el.style.height);
  // Intermediate drafts still need the normal shrink measurement. The previous
  // assignment only selects candidates; actual layout must prove either bound.
  if (
    !assignedHeight ||
    Number(assignedHeight[1]) <= minHeight ||
    (pixelMaxHeight && Number(assignedHeight[1]) >= maxHeight)
  ) {
    const height = Number.parseFloat(style.height);
    const scrollHeight = el.scrollHeight;
    const clientHeight = el.clientHeight;
    const overflows = scrollHeight > clientHeight + 1;
    // Rows and padding can exceed the CSS minimum. At the cap, a classic
    // scrollbar may itself cause overflow by narrowing text; measure it hidden.
    const atMinimum = !overflows && height === minHeight;
    const atMaximum =
      overflows &&
      pixelMaxHeight &&
      height >= maxHeight &&
      el.offsetWidth - el.clientWidth <=
        Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
    if (atMinimum || atMaximum) {
      updateTextareaOverflow(el, false, { scrollHeight, clientHeight });
      return;
    }
  }
  // Hide the browser's scrollbar while measuring; restore it only when the
  // final CSS-constrained height actually clips the draft.
  el.style.overflowY = "hidden";
  el.style.height = "auto";
  // scrollHeight includes padding but not borders. Bordered answer fields share
  // this owner with the borderless composer and must not scroll on a single line.
  const borderHeight = style.boxSizing === "border-box" ? el.offsetHeight - el.clientHeight : 0;
  el.style.height = `${Math.min(el.scrollHeight + borderHeight, maxHeight)}px`;
  updateTextareaOverflow(el);
  // Once capped, the textarea can perturb the sibling transcript without
  // resizing its viewport, so ResizeObserver has no correction to apply.
  if (thread) {
    if (scrollPosition?.anchorToEnd) {
      thread.scrollTop = thread.scrollHeight;
    }
    const after = thread.scrollTop;
    if (thread.clientHeight === threadHeight && after === scrollPosition?.scrollTop) {
      return;
    }
    // A following composer commit can hide this viewport from browser observers.
    publishTranscriptScroll(thread, {
      type: "resize",
      ...(scrollPosition?.anchorToEnd && scrollPosition.scrollTop !== after
        ? { scrollCorrection: { before: scrollPosition.scrollTop, after } }
        : {}),
    });
  }
}

export function observeTextareaOverflow(el: HTMLTextAreaElement) {
  if (composerTextareaResizeObservers.has(el)) {
    return;
  }
  const state: ComposerTextareaResizeObserverState = {
    observer: null,
    adjustmentFrame: null,
    overflowFrame: null,
    height: el.clientHeight,
    nativeInputPending: false,
    hasScrollbarGutter: false,
    editing: false,
    events: new AbortController(),
  };
  let width = el.getBoundingClientRect().width;
  const onScroll = () => updateTextareaOverflow(el, false);
  state.observer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          const nextWidth = el.getBoundingClientRect().width;
          if (nextWidth !== width) {
            width = nextWidth;
            if (
              composerTextareaResizeObservers.get(el) === state &&
              state.adjustmentFrame === null
            ) {
              state.adjustmentFrame = requestAnimationFrame(() => {
                state.adjustmentFrame = null;
                if (composerTextareaResizeObservers.get(el) === state) {
                  adjustTextareaHeight(el);
                }
              });
            }
            return;
          }
          updateTextareaOverflow(el, false);
        })
      : null;
  // Native caret scrolling can leave the active line inside the fade. Typing
  // and keyboard selection both need that line unfaded; only pointer browsing
  // or blur restores fades, not moving the caret within an already visible line.
  const onInteraction = (event: Event) => {
    if (
      event instanceof KeyboardEvent &&
      (event.isComposing ||
        !/^(ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End)$/u.test(event.key))
    ) {
      return;
    }
    state.editing = ["beforeinput", "input", "compositionstart", "keydown"].includes(event.type);
    if (event.type === "beforeinput" && hasNativeTextareaContentSizing(el)) {
      // Retain the transcript owner's committed end intent before native caret
      // scrolling can move an ancestor. This signal performs no layout reads.
      invalidateNativeTextareaLayout(el, state);
    }
    updateTextareaOverflow(el);
  };
  const eventOptions = { passive: true, signal: state.events.signal };
  for (const type of [
    "beforeinput",
    "input",
    "compositionstart",
    "wheel",
    "pointerdown",
    "keydown",
    "blur",
  ]) {
    el.addEventListener(type, onInteraction, eventOptions);
  }
  el.addEventListener("scroll", onScroll, eventOptions);
  composerTextareaResizeObservers.set(el, state);
  state.observer?.observe(el);
  updateTextareaOverflow(el);
}

export function disconnectTextareaOverflowObserver(el: HTMLTextAreaElement) {
  const state = composerTextareaResizeObservers.get(el);
  composerTextareaResizeObservers.delete(el);
  if (!state) {
    return;
  }
  state.observer?.disconnect();
  state.events.abort();
  if (state.adjustmentFrame !== null) {
    cancelAnimationFrame(state.adjustmentFrame);
  }
  if (state.overflowFrame !== null) {
    cancelAnimationFrame(state.overflowFrame);
  }
}

export function scheduleTextareaHeightAdjustment(el: HTMLTextAreaElement) {
  // Lit invokes ref callbacks before the textarea is connected and before its
  // controlled value is committed, so measure once the render has settled.
  queueMicrotask(() => {
    if (el.isConnected) {
      adjustTextareaHeight(el, { nativeInput: true });
    }
  });
}

export function focusComposerFromChrome(event: MouseEvent | PointerEvent, connected: boolean) {
  if (event.defaultPrevented) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  if (event.type === "pointerdown") {
    // Cancel only pointer focus; click and popover-owned focus still run.
    if (event.button === 0 && target.closest("summary, wa-dropdown>[slot='trigger']")) {
      event.preventDefault();
    }
    return;
  }
  if (!connected) {
    return;
  }
  if (target.closest(COMPOSER_CHROME_INTERACTIVE_SELECTOR)) {
    return;
  }
  const currentTarget = event.currentTarget;
  if (!(currentTarget instanceof HTMLElement)) {
    return;
  }
  currentTarget
    .querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea")
    ?.focus({ preventScroll: true });
}

export function preserveComposerFocusOnPrimaryAction(
  event: PointerEvent,
  textarea: HTMLTextAreaElement | null,
): void {
  const composerShell = textarea?.closest<HTMLElement>(".agent-chat__composer-shell");
  if (document.activeElement === textarea && composerShell) {
    event.preventDefault();
  }
}

export function restoreHistoryCaret(target: HTMLTextAreaElement, direction: "up" | "down") {
  requestAnimationFrame(() => {
    if (document.activeElement !== target) {
      return;
    }
    adjustTextareaHeight(target);
    const caret = direction === "up" ? 0 : target.value.length;
    target.selectionStart = caret;
    target.selectionEnd = caret;
  });
}

export function paneDomId(paneId: string, suffix: string): string {
  return `chat-${encodeURIComponent(paneId)}-${suffix}`;
}
