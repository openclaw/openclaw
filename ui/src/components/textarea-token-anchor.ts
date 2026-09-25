import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { configureAnchoredPopup } from "./anchored-overlay.ts";

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
export class TextareaTokenAnchor {
  private popup: WaPopup | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private start = 0;
  private value = "";
  private range: Range | null = null;
  private mirror: HTMLDivElement | null = null;
  private prefix: Text | null = null;
  private suffix: HTMLSpanElement | null = null;
  private anchor: HTMLSpanElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private frame: number | null = null;
  private stylesDirty = true;
  private lineHeight = 0;
  private readonly onOutOfView: () => void;

  constructor(onOutOfView: () => void) {
    this.onOutOfView = onOutOfView;
  }

  /** Call after rendering the popup, then when the token or textarea value changes. */
  update(popup: WaPopup, textarea: HTMLTextAreaElement, tokenStart: number): void {
    if (this.popup !== popup || this.textarea !== textarea) {
      this.close();
      this.popup = popup;
      this.textarea = textarea;
      const document = textarea.ownerDocument;
      this.mirror = document.createElement("div");
      this.mirror.setAttribute("aria-hidden", "true");
      this.mirror.style.cssText =
        "position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;box-sizing:border-box;border:0;margin:0;height:auto;min-height:0;overflow:hidden;contain:layout style paint;";
      this.prefix = document.createTextNode("");
      this.suffix = document.createElement("span");
      this.range = document.createRange();
      this.mirror.append(this.prefix, this.suffix);
      this.anchor = document.createElement("span");
      this.anchor.setAttribute("aria-hidden", "true");
      this.anchor.style.cssText =
        "position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;";
      document.body.append(this.mirror, this.anchor);
      configureAnchoredPopup(popup, this.anchor, "top", "start");
      this.resizeObserver = new ResizeObserver(this.invalidateStyles);
      this.resizeObserver.observe(textarea);
      document.addEventListener("scroll", this.schedule, true);
      document.defaultView?.addEventListener("resize", this.invalidateStyles);
      document.defaultView?.visualViewport?.addEventListener("resize", this.invalidateStyles);
      document.defaultView?.visualViewport?.addEventListener("scroll", this.schedule);
    }
    const value = textarea.value;
    if (this.value === value && this.start === tokenStart && !this.stylesDirty) {
      return;
    }
    this.value = value;
    this.start = tokenStart;
    this.schedule();
  }

  /** Close on dismissal, missing ref, and composer disconnect. Safe to reuse afterward. */
  close(): void {
    const document = this.textarea?.ownerDocument;
    const window = document?.defaultView;
    if (this.frame !== null) {
      window?.cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    document?.removeEventListener("scroll", this.schedule, true);
    window?.removeEventListener("resize", this.invalidateStyles);
    window?.visualViewport?.removeEventListener("resize", this.invalidateStyles);
    window?.visualViewport?.removeEventListener("scroll", this.schedule);
    if (this.popup) {
      this.popup.active = false;
    }
    this.mirror?.remove();
    this.anchor?.remove();
    this.popup = null;
    this.textarea = null;
    this.mirror = null;
    this.prefix = null;
    this.suffix = null;
    this.anchor = null;
    this.value = "";
    this.range = null;
    this.stylesDirty = true;
  }

  private readonly invalidateStyles = () => {
    this.stylesDirty = true;
    this.schedule();
  };

  private readonly schedule = () => {
    const window = this.textarea?.ownerDocument.defaultView;
    if (window && this.frame === null) {
      this.frame = window.requestAnimationFrame(this.measure);
    }
  };

  private readonly measure = () => {
    this.frame = null;
    const { textarea, popup, mirror, prefix, suffix, anchor } = this;
    if (!textarea?.isConnected || !popup?.isConnected || !mirror || !prefix || !suffix || !anchor) {
      this.close();
      return;
    }
    if (this.stylesDirty) {
      const style = textarea.ownerDocument.defaultView!.getComputedStyle(textarea);
      for (const property of TEXT_LAYOUT_PROPERTIES) {
        mirror.style.setProperty(property, style.getPropertyValue(property));
      }
      mirror.style.whiteSpace = textarea.wrap === "off" ? "pre" : "pre-wrap";
      this.lineHeight =
        Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
      this.stylesDirty = false;
    }
    // clientWidth excludes the native scrollbar, unlike the computed CSS width.
    mirror.style.width = `${textarea.clientWidth}px`;
    const start = Math.max(0, Math.min(this.start, textarea.value.length));
    const before = textarea.value.slice(0, start);
    const lineEnd = textarea.value.indexOf("\n", start);
    // Keep the rest of this paragraph: it can move the token to the next wrapped line.
    const after = textarea.value.slice(start, lineEnd < 0 ? undefined : lineEnd) || "\u200b";
    if (prefix.data !== before) {
      prefix.data = before;
    }
    if (suffix.textContent !== after) {
      suffix.textContent = after;
    }
    if (!suffix.firstChild || !this.range) {
      return;
    }
    this.range.setStart(suffix.firstChild, 0);
    this.range.collapse(true);
    const token = this.range.getClientRects()[0];
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
        (this.lineHeight - token.height) / 2 -
        textarea.scrollTop) *
        scaleY;
    const left = bounds.left + textarea.clientLeft * scaleX;
    const top = bounds.top + textarea.clientTop * scaleY;
    if (
      x < left ||
      x > left + textarea.clientWidth * scaleX ||
      y + this.lineHeight * scaleY <= top ||
      y >= top + textarea.clientHeight * scaleY
    ) {
      this.onOutOfView();
      return;
    }
    anchor.style.left = `${x}px`;
    anchor.style.top = `${y}px`;
    anchor.style.height = `${this.lineHeight * scaleY}px`;
    popup.active = true;
    popup.reposition();
  };
}
