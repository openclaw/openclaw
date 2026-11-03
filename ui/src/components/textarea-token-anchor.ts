import { listen } from "../lib/reactive/listener.ts";
import { bindOverlayAnchor } from "./overlay-anchor.ts";
import type { Overlay } from "./overlay-lifecycle.ts";

const TEXT_LAYOUT_PROPERTIES = [
  "direction",
  "font-family",
  "font-size",
  "font-size-adjust",
  "font-style",
  "font-weight",
  "font-stretch",
  "font-variant",
  "font-kerning",
  "font-feature-settings",
  "font-variation-settings",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "tab-size",
  "text-align",
  "text-indent",
  "text-transform",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "white-space",
  "overflow-wrap",
  "word-break",
] as const;

/** Measures only an open token menu; popup owns collision handling and the top layer. */
export function createTextareaTokenAnchor(onOutOfView: () => void) {
  let active: ReturnType<typeof bindTextarea> | undefined;

  /** Close on dismissal, missing ref, and composer disconnect. Safe to reuse afterward. */
  function close(): void {
    const previous = active;
    active = undefined;
    previous?.dispose();
  }

  return {
    close,
    updateNative(overlay: Overlay, textarea: HTMLTextAreaElement, tokenStart: number): void {
      const root = overlay.surface.getRootNode();
      const parent = root instanceof ShadowRoot ? root : textarea.ownerDocument.body;
      if (
        active?.popup !== overlay.surface ||
        active.textarea !== textarea ||
        active.anchor.parentNode !== parent
      ) {
        close();
        active = bindTextarea(overlay, textarea, parent, onOutOfView, close);
      }
      active.update(tokenStart);
    },
  };
}

function bindTextarea(
  overlay: Overlay,
  textarea: HTMLTextAreaElement,
  anchorParent: ParentNode,
  onOutOfView: () => void,
  close: () => void,
) {
  const popup = overlay.surface;
  const document = textarea.ownerDocument;
  const window = document.defaultView;
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  mirror.style.cssText =
    "position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;box-sizing:border-box;border:0;margin:0;height:auto;min-height:0;overflow:hidden;contain:layout style paint;";
  const prefix = document.createTextNode("");
  const suffix = document.createElement("span");
  const range = document.createRange();
  mirror.append(prefix, suffix);
  const anchor = document.createElement("span");
  anchor.setAttribute("aria-hidden", "true");
  anchor.style.cssText = "position:fixed;left:0;top:0;width:0;opacity:0;pointer-events:none;";
  document.body.append(mirror);
  // Named CSS anchors must share the native popup's tree scope.
  anchorParent.append(anchor);
  overlay.bindTrigger(textarea);
  overlay.setReturnTarget(textarea);
  const unbind = bindOverlayAnchor(popup, anchor, "top-start");
  let frame: number | null = null;
  let start = 0;
  let value = "";
  let stylesDirty = true;
  let lineHeight = 0;

  function schedule() {
    if (window && frame === null) {
      frame = window.requestAnimationFrame(measure);
    }
  }

  function invalidateStyles() {
    stylesDirty = true;
    schedule();
  }

  const resizeObserver = new ResizeObserver(invalidateStyles);
  resizeObserver.observe(textarea);
  const listeners = [
    listen(document, "scroll", schedule, true),
    window && listen(window, "resize", invalidateStyles),
    window?.visualViewport && listen(window.visualViewport, "resize", invalidateStyles),
    window?.visualViewport && listen(window.visualViewport, "scroll", schedule),
  ];

  function measure() {
    frame = null;
    if (!textarea.isConnected || !popup.isConnected) {
      close();
      return;
    }
    if (stylesDirty) {
      const style = window!.getComputedStyle(textarea);
      for (const property of TEXT_LAYOUT_PROPERTIES) {
        mirror.style.setProperty(property, style.getPropertyValue(property));
      }
      mirror.style.whiteSpace = textarea.wrap === "off" ? "pre" : "pre-wrap";
      lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
      stylesDirty = false;
    }
    // clientWidth excludes the native scrollbar, unlike the computed CSS width.
    mirror.style.width = `${textarea.clientWidth}px`;
    const position = Math.max(0, Math.min(start, textarea.value.length));
    const before = textarea.value.slice(0, position);
    const lineEnd = textarea.value.indexOf("\n", position);
    // Keep the rest of this paragraph: it can move the token to the next wrapped line.
    const after = textarea.value.slice(position, lineEnd < 0 ? undefined : lineEnd) || "\u200b";
    if (prefix.data !== before) {
      prefix.data = before;
    }
    if (suffix.textContent !== after) {
      suffix.textContent = after;
    }
    if (!suffix.firstChild) {
      return;
    }
    range.setStart(suffix.firstChild, 0);
    range.collapse(true);
    const token = range.getClientRects()[0];
    if (!token) {
      return;
    }
    const bounds = textarea.getBoundingClientRect();
    const mirrorBounds = mirror.getBoundingClientRect();
    const scaleX = textarea.offsetWidth ? bounds.width / textarea.offsetWidth : 1;
    const scaleY = textarea.offsetHeight ? bounds.height / textarea.offsetHeight : 1;
    const x =
      bounds.left +
      (textarea.clientLeft + token.left - mirrorBounds.left - textarea.scrollLeft) * scaleX;
    const y =
      bounds.top +
      (textarea.clientTop +
        token.top -
        mirrorBounds.top -
        (lineHeight - token.height) / 2 -
        textarea.scrollTop) *
        scaleY;
    const left = bounds.left + textarea.clientLeft * scaleX;
    const top = bounds.top + textarea.clientTop * scaleY;
    if (
      x < left ||
      x > left + textarea.clientWidth * scaleX ||
      y + lineHeight * scaleY <= top ||
      y >= top + textarea.clientHeight * scaleY
    ) {
      onOutOfView();
      return;
    }
    anchor.style.left = `${x}px`;
    anchor.style.top = `${y}px`;
    anchor.style.height = `${lineHeight * scaleY}px`;
    overlay.request(true);
  }

  return {
    popup,
    textarea,
    anchor,
    update(tokenStart: number) {
      if (value === textarea.value && start === tokenStart && !stylesDirty) {
        return;
      }
      value = textarea.value;
      start = tokenStart;
      schedule();
    },
    dispose() {
      if (frame !== null) {
        window?.cancelAnimationFrame(frame);
      }
      resizeObserver.disconnect();
      for (const stop of listeners) {
        stop?.();
      }
      overlay.retire();
      unbind();
      mirror.remove();
      anchor.remove();
    },
  };
}
