import { html, svg, type ReactiveController } from "lit";
import { t } from "../../i18n/index.ts";
import { registerDesktopEnglish } from "../../i18n/locales/en-desktop.ts";
import type { OpenClawLitElement } from "../../lit/openclaw-element.ts";
import { strokeIcon } from "../icons-tools.ts";
import type { DesktopPanelState } from "./desktop-panel-state.ts";
import { renderDesktopNotice } from "./desktop-panel-view.ts";

registerDesktopEnglish();

// Document PiP is not yet in our TypeScript DOM library. Detect the API, not the UA.
type PictureInPictureWindow = Window & {
  documentPictureInPicture?: {
    requestWindow(options: { width: number; height: number }): Promise<Window>;
  };
};

type DesktopPictureInPictureHost = OpenClawLitElement & {
  available: boolean;
  embedded: boolean;
  presented: boolean;
  documentMode: boolean;
};

const pipIcon = strokeIcon(svg`<rect x="2" y="3" width="20" height="18" rx="2" />
  <rect x="12" y="11" width="7" height="7" rx="1" />`);

/** View-only pixels from the existing RFB connection; never owns a socket or input. */
export class DesktopPictureInPicture implements ReactiveController {
  private errorText: string | null = null;
  private popup: Window | null = null;
  private pending = false;
  private generation = 0;
  private stopMirror: (() => void) | null = null;

  constructor(
    private readonly host: DesktopPictureInPictureHost,
    private readonly state: () => DesktopPanelState,
  ) {
    host.addController(this);
  }

  hostDisconnected(): void {
    this.close();
  }

  private get opener(): PictureInPictureWindow | null {
    return this.host.ownerDocument.defaultView;
  }

  private source(): HTMLCanvasElement | null {
    return this.host.available &&
      this.state() === "connected" &&
      (!this.host.embedded || this.host.presented)
      ? this.host.renderRoot.querySelector<HTMLCanvasElement>(".desktop-surface canvas")
      : null;
  }

  renderNotice(...[errorText, noticeText, availability]: Parameters<typeof renderDesktopNotice>) {
    return renderDesktopNotice(this.errorText ?? errorText, noticeText, availability);
  }

  renderButton() {
    const connected = this.state() === "connected";
    const className = this.host.documentMode ? "desktop-touch-action" : "desktop-toolbar-action";
    const supported =
      this.opener?.isSecureContext === true &&
      typeof this.opener.documentPictureInPicture?.requestWindow === "function";
    const label = this.popup
      ? t("desktop.exitPictureInPicture")
      : supported
        ? t("desktop.enterPictureInPicture")
        : t("desktop.pictureInPictureUnavailable");
    return html`<button
      class=${className + " desktop-picture-in-picture-button"}
      type="button"
      title=${label}
      aria-label=${label}
      aria-pressed=${this.popup ? "true" : "false"}
      aria-busy=${this.pending ? "true" : "false"}
      ?disabled=${!supported || !connected || this.pending}
      @click=${() => void this.toggle()}
    >
      ${pipIcon}
    </button>`;
  }

  close(): void {
    ++this.generation;
    this.stopMirror?.();
    this.stopMirror = null;
    const popup = this.popup;
    this.popup = null;
    popup?.close();
    this.errorText = null;
    this.host.requestUpdate();
  }

  private async toggle(): Promise<void> {
    if (this.popup) {
      this.close();
      return;
    }
    const opener = this.opener;
    const api = opener?.documentPictureInPicture;
    const source = this.source();
    if (this.pending || !opener?.isSecureContext || !api || !source || !this.host.isConnected) {
      return;
    }
    const generation = ++this.generation;
    this.pending = true;
    this.errorText = null;
    this.host.requestUpdate();
    let popup: Window | null = null;
    try {
      // Must happen directly in the click's user activation, before any await.
      popup = await api.requestWindow({ width: 640, height: 400 });
      // The user can close the native window before the request promise settles.
      if (
        popup.closed ||
        generation !== this.generation ||
        !this.host.isConnected ||
        this.source() !== source
      ) {
        popup.close();
        return;
      }
      this.popup = popup;
      this.startMirror(popup, source);
    } catch {
      popup?.close();
      if (generation === this.generation) {
        this.close();
        this.errorText = t("desktop.errors.pictureInPictureFailed");
      }
    } finally {
      this.pending = false;
      this.host.requestUpdate();
    }
  }

  private startMirror(popup: Window, source: HTMLCanvasElement): void {
    const doc = popup.document;
    doc.title = t("desktop.pictureInPictureTitle");
    doc.documentElement.lang = this.host.ownerDocument.documentElement.lang;
    const canvas = doc.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", t("desktop.pictureInPictureTitle"));
    // No input listeners or focusable remote surface. The original canvas stays mounted.
    canvas.style.cssText =
      "display:block;width:100%;height:100%;object-fit:contain;pointer-events:none";
    doc.body.style.cssText =
      "margin:0;height:100vh;background:Canvas;color:CanvasText;overflow:hidden";
    doc.body.replaceChildren(canvas);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Picture-in-Picture canvas is unavailable");
    }
    let frame = 0;
    let lastPaint = -Infinity;
    const onClose = () => {
      if (this.popup === popup) {
        this.close();
      }
    };
    popup.addEventListener("pagehide", onClose, { once: true });
    this.stopMirror = () => {
      popup.cancelAnimationFrame(frame);
      popup.removeEventListener("pagehide", onClose);
      canvas.remove();
    };
    const paint = (now: number) => {
      if (this.popup !== popup) {
        return;
      }
      if (popup.closed || this.source() !== source || !source.isConnected) {
        this.close();
        return;
      }
      try {
        // noVNC 1.7 flips incoming frames synchronously. Use the visible PiP window's
        // clock, NOT the opener's rAF (suspended in background tabs). Bound copy work
        // to 30fps and the displayed resolution; no encoding, stream, or second RFB.
        if (now - lastPaint >= 1000 / 30 && source.width > 0 && source.height > 0) {
          const scale = Math.min(
            1,
            (popup.innerWidth * popup.devicePixelRatio) / source.width,
            (popup.innerHeight * popup.devicePixelRatio) / source.height,
          );
          const width = Math.max(1, Math.round(source.width * scale));
          const height = Math.max(1, Math.round(source.height * scale));
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
          }
          context.drawImage(source, 0, 0, width, height);
          lastPaint = now;
        }
        frame = popup.requestAnimationFrame(paint);
      } catch {
        // Never leave a frozen image presented as a connected viewer.
        this.close();
        this.errorText = t("desktop.errors.pictureInPictureFailed");
        this.host.requestUpdate();
      }
    };
    frame = popup.requestAnimationFrame(paint);
  }
}
