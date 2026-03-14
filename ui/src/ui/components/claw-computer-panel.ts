// @ts-ignore - noVNC types are not available
import RFB from "@novnc/novnc";
// ui/src/ui/components/claw-computer-panel.ts
import { LitElement, html, css } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { createRef, ref, Ref } from "lit/directives/ref.js";
// @ts-ignore - noVNC types are not available

// Compatible with both .default and non-.default versions
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RFBClass = (RFB as any).default || RFB;

// RFB instance type definition
interface RFBInstance {
  disconnect(): void;
  addEventListener(event: string, callback: (e?: unknown) => void): void;
  scaleViewport: boolean;
  clipViewport: boolean;
  resizeSession: boolean;
  resize?(): void;
}

@customElement("claw-computer-panel")
export class ClawComputerPanel extends LitElement {
  @property() vncUrl = "";
  @property() vncTarget = "";
  @property() password = "";

  @state() status = "等待連接...";
  @state() isConnected = false;
  @state() isFitted = true;

  private rfb: RFBInstance | null = null;
  private screenRef: Ref<HTMLDivElement> = createRef<HTMLDivElement>();
  private autoConnectAttempted = false;

  @property({ type: Boolean }) enabled = false;

  updated(changedProperties: Map<string, unknown>) {
    if (changedProperties.has("enabled")) {
      if (this.enabled) {
        if (!this.isConnected) {
          setTimeout(() => void this.connect(), 100);
        }
      } else {
        this.disconnect();
      }
    }
  }

  static styles = css`
    :host {
      display: block;
      height: 100%;
      background: var(--bg-accent);
      color: var(--text);
      font-family: system-ui, sans-serif;
    }
    .container {
      height: 100%;
      display: flex;
      flex-direction: column;
      position: relative;
    }
    .screen-container {
      flex: 1;
      width: 100%;
      height: 100%;
      background: var(--bg-accent);
      overflow: hidden;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .screen {
      /* Remove fixed width/height to allow shrink-wrapping */
      width: auto;
      height: auto;
      /* Maximize but preserve aspect ratio via flex item behavior */
      max-width: 100%;
      max-height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;

      /* macOS-style window border wrapper */
      padding: 6px;
      padding-top: 36px; /* Extra space for title bar controls */
      background: color-mix(
        in srgb,
        var(--bg-accent),
        black 10%
      ); /* Ensure darker than container */
      border-radius: 6px;
      box-shadow:
        0 0 0 1px var(--border),
        0 20px 50px rgba(0, 0, 0, 0.4);
      box-sizing: border-box;
      position: relative;
    }

    /* Window controls (fake traffic lights) */
    .window-controls {
      position: absolute;
      top: 12px;
      left: 12px;
      display: flex;
      gap: 8px;
      z-index: 20;
    }

    .window-control {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      cursor: pointer;
      border: 1px solid rgba(0, 0, 0, 0.1);
      transition:
        transform 0.1s,
        opacity 0.2s;
    }
    .window-control:hover {
      opacity: 0.8;
      transform: scale(1.1);
    }

    .window-control.maximize {
      background-color: #27c93f;
      border-color: #1aab29;
    }
    .window-control.close {
      background-color: #ff5f56;
      border-color: #e0443e;
    }
    .screen > div:not(.window-controls) {
      /* Fix for noVNC wrapper div */
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 100% !important;
      height: 100% !important;
      background: transparent !important;
    }
    .screen canvas {
      /* Force canvas to maintain aspect ratio within container */
      max-width: 100% !important;
      max-height: 100% !important;
      width: auto !important;
      height: auto !important;
      /* Remove default canvas outline/border */
      outline: none;
      display: block; /* Remove inline gap */
      margin: auto !important;
      border-radius: 0;
      box-shadow: none;
    }
    .status-overlay {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: var(--card);
      padding: 16px 24px;
      border-radius: 8px;
      color: var(--text);
      font-weight: 500;
      pointer-events: none;
      z-index: 10;
      border: 1px solid var(--border);
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
  `;

  render() {
    return html`
      <div class="container">
        ${!this.isConnected ? html`<div class="status-overlay">${this.status}</div>` : null}
        <div class="screen-container">
          <div ${ref(this.screenRef)} class="screen">
            <div class="window-controls">
              <div class="window-control close" @click=${this.handleClose}></div>
              <div class="window-control maximize" @click=${this.toggleFullscreen}></div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private handleClose = () => {
    // Dispatch event to parent to close the panel
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  };

  private connect = async () => {
    let url =
      this.vncUrl || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/vnc`;

    // Append target configuration if available
    if (this.vncTarget) {
      try {
        const urlObj = new URL(url);
        urlObj.searchParams.set("target", this.vncTarget);
        url = urlObj.toString();
      } catch {
        // Fallback for non-standard WebSocket URLs if URL parsing fails
        if (url.includes("?")) {
          url += `&target=${encodeURIComponent(this.vncTarget)}`;
        } else {
          url += `?target=${encodeURIComponent(this.vncTarget)}`;
        }
      }
    }

    if (this.rfb) {
      this.rfb.disconnect();
    }

    this.status = "正在連接...";
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    let screen = this.screenRef.value;

    if (!screen) {
      // Fallback: try to find the element via shadowRoot if ref failed
      screen = this.shadowRoot?.querySelector(".screen") as HTMLDivElement;
    }

    if (!screen) {
      console.error("Screen element not found");
      this.status = "初始化失败：找不到屏幕元素";
      return;
    }

    // Clear previous VNC canvas elements to prevent duplication
    const existingCanvases = screen.querySelectorAll("canvas");
    existingCanvases.forEach((canvas) => canvas.remove());

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Constructor = RFBClass as new (
        target: HTMLElement,
        url: string,
        options?: unknown,
      ) => RFBInstance;

      this.rfb = new Constructor(screen, url, {
        credentials: { password: this.password || undefined },
        resizeSession: true,
        clipViewport: true,
      });

      // @ts-ignore
      this.rfb.addEventListener("securityfailure", (e: CustomEvent) => {
        console.error("VNC security failure:", e.detail);
        this.status = `Security negotiation failed: ${e.detail.reason || "Unknown reason"}`;
      });

      if (this.rfb) {
        this.rfb.scaleViewport = this.isFitted;
      }

      this.rfb?.addEventListener("connect", () => {
        this.isConnected = true;
        this.status = "已連線成功 ✓（改變視窗大小會自動適配）";
        setTimeout(() => this.rfb?.resize?.(), 100);
      });

      this.rfb?.addEventListener("disconnect", () => {
        this.isConnected = false;
        this.status = "連線中斷";
        this.rfb = null;
      });
    } catch (error) {
      console.error("Failed to create RFB instance:", error);
      this.status = `连接失败: ${error as string}`;
    }
  };

  private disconnect = () => {
    if (this.rfb) {
      this.rfb.disconnect();
    }
  };

  private setFitMode(fitted: boolean) {
    this.isFitted = fitted;
    if (this.rfb) {
      this.rfb.scaleViewport = fitted;
      this.rfb.clipViewport = true;
      setTimeout(() => this.rfb?.resize?.(), 50);
    }
  }

  private handleResize = () => {
    if (this.rfb && this.isConnected) {
      setTimeout(() => this.rfb?.resize?.(), 80);
    }
  };

  private toggleFullscreen = () => {
    const container = this.shadowRoot?.querySelector(".screen-container");
    if (container) {
      void (container as HTMLElement).requestFullscreen?.();
    }
  };

  private handlePasswordKeydown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      void this.connect();
    }
  };

  firstUpdated() {
    window.addEventListener("resize", this.handleResize);

    // Auto-connect if enabled and URL is configured
    if (this.enabled && this.vncUrl) {
      // Use setTimeout to ensure DOM is fully ready and to allow UI to render first
      setTimeout(() => {
        void this.connect();
      }, 100);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("resize", this.handleResize);
    this.disconnect();
  }
}
