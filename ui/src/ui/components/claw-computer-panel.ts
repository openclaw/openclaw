// @ts-ignore - noVNC types are not available
import RFB from "@novnc/novnc";
// ui/src/ui/components/claw-computer-panel.ts
import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { createRef, ref, Ref } from "lit/directives/ref.js";

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
  @state() status = "等待連接...";
  @state() isConnected = false;
  @state() isFitted = true;
  @state() password = "";

  private rfb: RFBInstance | null = null;
  private screenRef: Ref<HTMLDivElement> = createRef<HTMLDivElement>();

  static styles = css`
    :host {
      display: block;
      height: 100%;
      background: #0a0a0a;
      color: #eee;
      font-family: system-ui, sans-serif;
    }
    .container {
      height: 100%;
      display: flex;
      flex-direction: column;
      padding: 16px;
    }
    h2 {
      text-align: center;
      margin: 0 0 16px 0;
      color: #ddd;
    }
    .controls {
      background: #1a1a1a;
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 16px;
      border: 1px solid #333;
    }
    label {
      display: block;
      margin-bottom: 6px;
      font-weight: 500;
    }
    input {
      width: 100%;
      padding: 10px;
      background: #222;
      border: 1px solid #444;
      color: #eee;
      border-radius: 6px;
      margin-bottom: 12px;
    }
    .btn-group {
      display: flex;
      gap: 8px;
      margin: 12px 0;
      flex-wrap: wrap;
    }
    button {
      padding: 10px 16px;
      background: #0066cc;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: bold;
    }
    button:hover:not(:disabled) {
      background: #007fff;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .active {
      background: #0088ff !important;
    }
    .screen-container {
      flex: 1;
      min-height: 400px;
      background: #000;
      border: 2px solid #444;
      border-radius: 8px;
      overflow: hidden;
      position: relative;
    }
    .screen {
      width: 100%;
      height: 100%;
    }
    .status {
      margin-top: 8px;
      text-align: center;
      font-weight: bold;
      min-height: 24px;
    }
  `;

  render() {
    return html`
      <div class="container">
        <h2>noVNC - 自動調整版（穩定無錯誤）</h2>
        <p style="text-align:center; color:#888;">
          ws://localhost:8081（已轉發到你的 10.75.171.0:25900）
        </p>
        <div class="controls">
          <label>VNC 密碼（如果有）:</label>
          <input type="password" placeholder="留空 = 無密碼"
                 .value=${this.password}
                 @input=${(e: Event) => {
                   this.password = (e.target as HTMLInputElement).value;
                 }}
                 @keydown=${this.handlePasswordKeydown} />
          <div class="btn-group">
            <button @click=${this.connect} ?disabled=${this.isConnected}>連接</button>
            <button @click=${this.disconnect} ?disabled=${!this.isConnected}>斷開</button>
            <button @click=${this.toggleFullscreen}>全螢幕</button>
          </div>
          <div style="margin-top:12px;">
            <strong>視窗縮放模式：</strong>
            <button class=${this.isFitted ? "active" : ""} @click=${() => this.setFitMode(true)}>適配視窗</button>
            <button class=${!this.isFitted ? "active" : ""} @click=${() => this.setFitMode(false)}>1:1 原尺寸</button>
          </div>
          <div class="status" style="color: ${this.isConnected ? "#4caf50" : "#aaa"}">
            ${this.status}
          </div>
        </div>
        <div class="screen-container">
          <div ${ref(this.screenRef)} class="screen" style="display: ${this.isConnected ? "block" : "none"}"></div>
        </div>
      </div>
    `;
  }

  private connect = async () => {
    const url = "ws://localhost:8081";
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
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("resize", this.handleResize);
    this.disconnect();
  }
}
