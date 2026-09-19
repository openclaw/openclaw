import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { configureAnchoredPopup } from "./anchored-overlay.ts";
import type { ComposerEditor } from "./composer-editor.ts";

/** Uses the editor's rendered document, including chip widths, while the menu is open. */
export class ComposerTokenAnchor {
  private popup: WaPopup | null = null;
  private editor: ComposerEditor | null = null;
  private start = 0;
  private anchor: HTMLSpanElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private frame: number | null = null;

  constructor(private readonly onOutOfView: () => void) {}

  update(popup: WaPopup, editor: ComposerEditor, tokenStart: number): void {
    if (this.popup !== popup || this.editor !== editor) {
      this.close();
      this.popup = popup;
      this.editor = editor;
      const document = editor.ownerDocument;
      this.anchor = document.createElement("span");
      this.anchor.setAttribute("aria-hidden", "true");
      this.anchor.style.cssText =
        "position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;";
      document.body.append(this.anchor);
      configureAnchoredPopup(popup, this.anchor, "top", "start");
      this.resizeObserver = new ResizeObserver(this.schedule);
      this.resizeObserver.observe(editor);
      document.addEventListener("scroll", this.schedule, true);
      document.defaultView?.addEventListener("resize", this.schedule);
      document.defaultView?.visualViewport?.addEventListener("resize", this.schedule);
      document.defaultView?.visualViewport?.addEventListener("scroll", this.schedule);
    }
    this.start = tokenStart;
    this.schedule();
  }

  close(): void {
    const document = this.editor?.ownerDocument;
    const window = document?.defaultView;
    if (this.frame !== null) {
      window?.cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    document?.removeEventListener("scroll", this.schedule, true);
    window?.removeEventListener("resize", this.schedule);
    window?.visualViewport?.removeEventListener("resize", this.schedule);
    window?.visualViewport?.removeEventListener("scroll", this.schedule);
    if (this.popup) {
      this.popup.active = false;
    }
    this.anchor?.remove();
    this.popup = null;
    this.editor = null;
    this.anchor = null;
  }

  private readonly schedule = () => {
    const window = this.editor?.ownerDocument.defaultView;
    if (window && this.frame === null) {
      this.frame = window.requestAnimationFrame(this.measure);
    }
  };

  private readonly measure = () => {
    this.frame = null;
    const { editor, popup, anchor } = this;
    if (!editor?.isConnected || !popup?.isConnected || !anchor) {
      this.close();
      return;
    }
    const token = editor.coordsAtPos(Math.max(0, Math.min(this.start, editor.value.length)));
    if (!token) {
      return;
    }
    const bounds = editor.getBoundingClientRect();
    if (
      token.left < bounds.left ||
      token.left > bounds.right ||
      token.bottom <= bounds.top ||
      token.top >= bounds.bottom
    ) {
      this.onOutOfView();
      return;
    }
    anchor.style.left = `${token.left}px`;
    anchor.style.top = `${token.top}px`;
    anchor.style.height = `${token.bottom - token.top}px`;
    popup.active = true;
    popup.reposition();
  };
}
