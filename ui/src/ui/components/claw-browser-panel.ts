import { LitElement, html, css } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { createRef, ref, Ref } from "lit/directives/ref.js";

class CDPClient {
  public ws: WebSocket;
  private messageId = 0;
  private pendingPromises = new Map<number, { resolve: Function; reject: Function }>();
  private eventHandlers = new Map<string, Set<Function>>();

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", this.handleMessage.bind(this));
  }

  private handleMessage(event: MessageEvent) {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined) {
      const p = this.pendingPromises.get(msg.id);
      if (p) {
        if (msg.error) {
          p.reject(msg.error);
        } else {
          p.resolve(msg.result);
        }
        this.pendingPromises.delete(msg.id);
      }
    } else if (msg.method) {
      const handlers = this.eventHandlers.get(msg.method);
      if (handlers) {
        if (msg.sessionId) {
          msg.params = msg.params || {};
          msg.params.sessionId = msg.sessionId;
        }
        handlers.forEach((fn) => fn(msg.params));
      }
    }
  }

  public send(method: string, params: unknown = {}, sessionId?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("WebSocket is not open"));
      }
      const id = ++this.messageId;
      this.pendingPromises.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  public on(method: string, handler: Function) {
    if (!this.eventHandlers.has(method)) {
      this.eventHandlers.set(method, new Set<Function>());
    }
    this.eventHandlers.get(method)!.add(handler);
  }

  public close() {
    this.ws.close();
  }
}

@customElement("claw-browser-panel")
export class ClawBrowserPanel extends LitElement {
  @property({ type: String }) activeTool = "browser";
  @property({ type: String }) gatewayUrl = "";
  @property({ type: Boolean }) enabled = false;

  @state() status = "等待連接...";
  @state() wsConnected = false;
  @state() isFitted = true;
  @state() currentUrl = "";

  private canvasRef: Ref<HTMLCanvasElement> = createRef<HTMLCanvasElement>();
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  private cdp: CDPClient | null = null;
  private currentSessionId: string | null = null;
  private tabs: { targetId: string; sessionId?: string; url: string; title: string }[] = [];
  private pollInterval: number | null = null;

  private pageMeta = { width: 1280, height: 720 };
  private isMouseDown = false;
  private lastMouseMoveTime = 0;
  private isComposing = false;
  private imeInput: HTMLTextAreaElement | null = null;

  private isFloating = false;
  private tempIsFloating = false;
  private dockedOffsetY = 0;
  private dockedOffsetX = 0;
  private floatingRect = { x: 0, y: 0, width: 800, height: 600 };

  private dragStart = { x: 0, y: 0 };
  private canvasRatio = 16 / 9;
  private initialRect = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    offsetY: 0,
    offsetX: 0,
    containerHeight: 0,
    containerTop: 0,
    containerLeft: 0,
    containerWidth: 0,
  };
  private isDragging = false;
  private isResizing = false;
  private resizeEdge = "";
  private aspectRatio = 1;
  private dragAnchor = { x: 0, y: 0 };

  private resizeObserver: ResizeObserver | null = null;

  private setupResizeObserver() {
    if (this.resizeObserver) {
      return;
    }
    this.resizeObserver = new ResizeObserver(() => this.clampDockedOffset());
    this.resizeObserver.observe(this);
  }

  private clampDockedOffset() {
    if (this.isFloating || !this.shadowRoot) {
      return;
    }
    const screenElement = this.shadowRoot.querySelector(".screen");
    if (!screenElement) {
      return;
    }
    const screen = screenElement as HTMLElement;
    const hostHeight = this.offsetHeight;
    const screenHeight = screen.offsetHeight;
    const style = getComputedStyle(this.shadowRoot.querySelector(".screen-container")!);
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const contentHeight = hostHeight - paddingTop;
    const centerTop = (contentHeight - screenHeight) / 2;
    const maxOffset = Math.max(0, centerTop);
    if (Math.abs(this.dockedOffsetY) > maxOffset) {
      this.dockedOffsetY = Math.max(-maxOffset, Math.min(maxOffset, this.dockedOffsetY));
    }
  }

  updated(changedProperties: Map<string, unknown>) {
    if (changedProperties.has("enabled")) {
      if (this.enabled) {
        if (!this.wsConnected) {
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
      --vnc-border-color: var(--border);
      --vnc-window-bg: color-mix(in srgb, var(--bg-accent), black 10%);
    }
    @media (prefers-color-scheme: light) {
      :host {
        --vnc-border-color: color-mix(in srgb, var(--border), black 15%);
        --vnc-window-bg: color-mix(in srgb, var(--bg-accent), black 10%);
      }
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --vnc-border-color: color-mix(in srgb, var(--border), white 15%);
        --vnc-window-bg: color-mix(in srgb, var(--bg-accent), white 5%);
      }
    }
    :host([theme="light"]) {
      --vnc-border-color: color-mix(in srgb, var(--border), black 15%);
      --vnc-window-bg: color-mix(in srgb, var(--bg-accent), black 10%);
    }
    :host([theme="dark"]) {
      --vnc-border-color: color-mix(in srgb, var(--border), white 15%);
      --vnc-window-bg: color-mix(in srgb, var(--bg-accent), white 5%);
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
      padding-top: 50px;
      box-sizing: border-box;
    }
    .screen {
      width: auto;
      height: auto;
      max-width: 100%;
      max-height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 5.4px;
      padding-top: 32.4px;
      background: var(--vnc-window-bg);
      border-radius: 6px;
      box-shadow:
        0 0 0 1px var(--vnc-border-color, var(--border)),
        0 20px 50px rgba(0, 0, 0, 0.4);
      box-sizing: border-box;
      position: relative;
      pointer-events: none;
    }
    .screen > *:not(.drag-handle):not(.window-controls):not(.resize-handle) {
      pointer-events: auto;
    }
    .screen.dragging > *:not(.drag-handle):not(.window-controls):not(.resize-handle) {
      pointer-events: none !important;
    }
    .screen canvas {
      pointer-events: auto !important;
    }
    .viewport-wrapper {
      position: relative;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      overflow: auto;
    }
    canvas {
      background: #000;
      border: 2px solid #444;
      border-radius: 8px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      outline: none;
      cursor: crosshair;
      max-width: 100%;
      object-fit: contain;
    }
    canvas:focus {
      border-color: var(--accent, #61dafb);
    }
    .window-controls {
      position: absolute;
      top: 10.8px;
      left: 10.8px;
      display: flex;
      gap: 7.2px;
      z-index: 25;
      pointer-events: auto;
    }
    .window-control {
      width: 10.8px;
      height: 10.8px;
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
    .window-control.minimize {
      background-color: #ffbd2e;
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
      z-index: 100;
      border: 1px solid var(--border);
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    .screen.floating {
      position: fixed;
      z-index: 9999;
      top: 0;
      left: 0;
      max-width: none;
      max-height: none;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
    }
    .top-toolbar {
      position: absolute;
      top: 0;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 8px;
      padding: 6px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 999px;
      z-index: 100;
      pointer-events: auto;
    }
    .toolbar-btn {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
    }
    .toolbar-btn:hover {
      background: var(--bg-hover);
      color: var(--text);
    }
    .toolbar-btn.active {
      background: var(--accent);
      color: white;
      border-color: var(--accent);
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    }
    .toolbar-btn svg {
      width: 18px;
      height: 18px;
      stroke: currentColor;
      fill: none;
      stroke-width: 2px;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .drag-handle {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 32.4px;
      cursor: grab;
      z-index: 20;
      pointer-events: auto;
    }
    .drag-handle:active {
      cursor: grabbing;
    }
    .resize-handle {
      position: absolute;
      background: transparent;
      z-index: 30;
      pointer-events: auto;
    }
    .resize-handle.top {
      top: -5px;
      left: 0;
      right: 0;
      height: 10px;
      cursor: ns-resize;
    }
    .resize-handle.bottom {
      bottom: -5px;
      left: 0;
      right: 0;
      height: 10px;
      cursor: ns-resize;
    }
    .resize-handle.left {
      left: -5px;
      top: 0;
      bottom: 0;
      width: 10px;
      cursor: ew-resize;
    }
    .resize-handle.right {
      right: -5px;
      top: 0;
      bottom: 0;
      width: 10px;
      cursor: ew-resize;
    }
    .resize-handle.top-left {
      top: -5px;
      left: -5px;
      width: 15px;
      height: 15px;
      cursor: nwse-resize;
      z-index: 35;
    }
    .resize-handle.top-right {
      top: -5px;
      right: -5px;
      width: 15px;
      height: 15px;
      cursor: nesw-resize;
      z-index: 35;
    }
    .resize-handle.bottom-left {
      bottom: -5px;
      left: -5px;
      width: 15px;
      height: 15px;
      cursor: nesw-resize;
      z-index: 35;
    }
    .resize-handle.bottom-right {
      bottom: -5px;
      right: -5px;
      width: 15px;
      height: 15px;
      cursor: nwse-resize;
      z-index: 35;
    }
    .url-bar {
      position: absolute;
      top: 50px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 8px;
      padding: 8px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      z-index: 50;
      pointer-events: auto;
    }
    .url-bar input {
      width: 300px;
      padding: 6px 12px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-accent);
      color: var(--text);
      font-size: 13px;
      outline: none;
    }
    .url-bar input:focus {
      border-color: var(--accent);
    }
    .url-bar button {
      padding: 6px 12px;
      border: none;
      border-radius: 4px;
      background: var(--accent);
      color: white;
      cursor: pointer;
      font-size: 13px;
    }
    .url-bar button:hover {
      opacity: 0.9;
    }
  `;

  render() {
    const displayFloating = this.isDragging ? this.tempIsFloating : this.isFloating;
    const screenStyle = displayFloating
      ? `transform: translate(${this.floatingRect.x}px, ${this.floatingRect.y}px); width: ${this.floatingRect.width}px; height: ${this.floatingRect.height}px;`
      : `transform: translate(${this.dockedOffsetX}px, ${this.dockedOffsetY}px);`;

    return html`
      <div class="container" tabindex="0">
        ${!this.wsConnected ? html`<div class="status-overlay">${this.status}</div>` : null}
        <div class="url-bar">
          <input
            type="text"
            .value=${this.currentUrl}
            placeholder="输入网址后回车跳转"
            @keydown=${this.handleUrlKeyDown}
          />
          <button @click=${this.handleNavigate}>跳转</button>
        </div>
        <div class="screen-container">
          ${
            !displayFloating
              ? html`
            <div class="top-toolbar">
              <button
                class="toolbar-btn ${this.activeTool === "vnc" ? "active" : ""}"
                @click=${() => this.setActiveTool("vnc")}
                title="Remote Desktop"
              >
                <svg viewBox="0 0 24 24">
                  <rect width="20" height="14" x="2" y="3" rx="2" />
                  <line x1="8" x2="16" y1="21" y2="21" />
                  <line x1="12" x2="12" y1="17" y2="21" />
                </svg>
              </button>
              <button
                class="toolbar-btn ${this.activeTool === "browser" ? "active" : ""}"
                @click=${() => this.setActiveTool("browser")}
                title="Browser"
              >
                <svg viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="2" x2="22" y1="12" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              </button>
              <button
                class="toolbar-btn ${this.activeTool === "images" ? "active" : ""}"
                @click=${() => this.setActiveTool("images")}
                title="Images"
              >
                <svg viewBox="0 0 24 24">
                  <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                </svg>
              </button>
            </div>
          `
              : null
          }
          <div
            class="screen ${displayFloating ? "floating" : ""}"
            style="${screenStyle}"
            tabindex="0"
          >
            <canvas
              ${ref(this.canvasRef)}
              width=${this.pageMeta.width}
              height=${this.pageMeta.height}
              @mousedown=${this.handleMouseDown}
              @mouseup=${this.handleMouseUp}
              @mousemove=${this.handleMouseMove}
              @wheel=${this.handleWheel}
              @click=${this.handleCanvasClick}
            ></canvas>
            <textarea
              id="ime-input"
              style="position:absolute; opacity:0; pointer-events:none; width:1px; height:1px;"
              @compositionstart=${this.handleCompositionStart}
              @compositionend=${this.handleCompositionEnd}
              @input=${this.handleImeInput}
              @keydown=${this.handleImeKeyDown}
              @keyup=${this.handleImeKeyUp}
            ></textarea>
            <div class="drag-handle" @mousedown=${this.handleDragStart}></div>
            ${
              displayFloating
                ? html`
              <div class="resize-handle top" @mousedown=${(e: MouseEvent) => this.handleResizeStart(e, "top")}></div>
              <div class="resize-handle bottom" @mousedown=${(e: MouseEvent) => this.handleResizeStart(e, "bottom")}></div>
              <div class="resize-handle left" @mousedown=${(e: MouseEvent) => this.handleResizeStart(e, "left")}></div>
              <div class="resize-handle right" @mousedown=${(e: MouseEvent) => this.handleResizeStart(e, "right")}></div>
              <div class="resize-handle top-left" @mousedown=${(e: MouseEvent) => this.handleResizeStart(e, "top-left")}></div>
              <div class="resize-handle top-right" @mousedown=${(e: MouseEvent) => this.handleResizeStart(e, "top-right")}></div>
              <div class="resize-handle bottom-left" @mousedown=${(e: MouseEvent) => this.handleResizeStart(e, "bottom-left")}></div>
              <div class="resize-handle bottom-right" @mousedown=${(e: MouseEvent) => this.handleResizeStart(e, "bottom-right")}></div>
            `
                : null
            }
            <div class="window-controls">
              <div class="window-control close" @click=${this.handleClose}></div>
              <div class="window-control minimize"></div>
              <div class="window-control maximize" @click=${this.toggleFullscreen}></div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private getCanvas(): HTMLCanvasElement | null {
    if (this.canvas) {
      return this.canvas;
    }
    if (this.canvasRef?.value) {
      this.canvas = this.canvasRef.value;
      this.ctx = this.canvas.getContext("2d");
    }
    return this.canvas;
  }

  private getImeInput(): HTMLTextAreaElement | null {
    if (this.imeInput) {
      return this.imeInput;
    }
    if (this.shadowRoot) {
      this.imeInput = this.shadowRoot.querySelector("#ime-input") as HTMLTextAreaElement;
    }
    return this.imeInput;
  }

  private getMousePos(e: MouseEvent): { x: number; y: number } | null {
    const canvas = this.getCanvas();
    if (!canvas) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  }

  private sendMouseEvent(
    type: string,
    x: number,
    y: number,
    button: string = "left",
    clickCount: number = 1,
    buttons?: string,
  ) {
    if (!this.cdp || !this.wsConnected || !this.currentSessionId) {
      return;
    }
    this.cdp
      .send(
        "Input.dispatchMouseEvent",
        { type, x, y, button, clickCount, buttons },
        this.currentSessionId,
      )
      .catch(() => {});
  }

  private sendKeyEvent(type: string, params: unknown) {
    if (!this.cdp || !this.wsConnected || !this.currentSessionId) {
      return;
    }
    this.cdp
      .send("Input.dispatchKeyEvent", Object.assign({ type }, params), this.currentSessionId)
      .catch(() => {});
  }

  private handleMouseDown = (e: MouseEvent) => {
    const pos = this.getMousePos(e);
    if (!pos) {
      return;
    }
    e.preventDefault();
    this.isMouseDown = true;
    this.getCanvas()?.focus();
    this.getImeInput()?.focus();
    this.sendMouseEvent("mousePressed", pos.x, pos.y, "left", 1, "left");
  };

  private handleMouseUp = (e: MouseEvent) => {
    const pos = this.getMousePos(e);
    if (!pos) {
      return;
    }
    this.isMouseDown = false;
    this.sendMouseEvent("mouseReleased", pos.x, pos.y, "left", 1, "none");
  };

  private handleMouseMove = (e: MouseEvent) => {
    const pos = this.getMousePos(e);
    if (!pos) {
      return;
    }
    const now = Date.now();
    if (now - this.lastMouseMoveTime < 16) {
      return;
    }
    this.lastMouseMoveTime = now;
    this.sendMouseEvent("mouseMoved", pos.x, pos.y, "none", 0, this.isMouseDown ? "left" : "none");
  };

  private handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    const pos = this.getMousePos(e);
    if (!pos) {
      return;
    }
    this.sendMouseEvent("mouseWheel", pos.x, pos.y, "none", 0, "none");
    if (this.cdp && this.wsConnected && this.currentSessionId) {
      this.cdp
        .send(
          "Input.dispatchMouseEvent",
          {
            type: "mouseWheel",
            x: pos.x,
            y: pos.y,
            deltaX: e.deltaX,
            deltaY: e.deltaY,
          },
          this.currentSessionId,
        )
        .catch(() => {});
    }
  };

  private handleCanvasClick = () => {
    this.getImeInput()?.focus();
  };

  private handleCompositionStart = () => {
    this.isComposing = true;
  };

  private handleCompositionEnd = (e: CompositionEvent) => {
    this.isComposing = false;
    if (!this.cdp || !this.wsConnected || !this.currentSessionId || !e.data) {
      return;
    }
    this.cdp.send("Input.insertText", { text: e.data }, this.currentSessionId).catch(() => {});
    const ime = this.getImeInput();
    if (ime) {
      ime.value = "";
    }
  };

  private handleImeInput = (e: Event) => {
    const target = e.target as HTMLTextAreaElement;
    if (this.isComposing || !this.cdp || !this.wsConnected || !this.currentSessionId) {
      return;
    }
    const val = target.value;
    if (val.length > 1) {
      this.cdp.send("Input.insertText", { text: val }, this.currentSessionId).catch(() => {});
      target.value = "";
    }
  };

  private handleImeKeyDown = (e: KeyboardEvent) => {
    if (!this.cdp || !this.wsConnected || !this.currentSessionId) {
      return;
    }
    if (this.isComposing || e.keyCode === 229) {
      return;
    }
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(e.code)) {
      e.preventDefault();
    }
    const text = e.key.length === 1 ? e.key : undefined;
    this.sendKeyEvent(text ? "keyDown" : "rawKeyDown", {
      windowsVirtualKeyCode: e.keyCode,
      nativeVirtualKeyCode: e.keyCode,
      key: e.key,
      code: e.code,
      text,
      unmodifiedText: text,
    });
    if (text) {
      setTimeout(() => {
        if (!this.isComposing) {
          const ime = this.getImeInput();
          if (ime) {
            ime.value = "";
          }
        }
      }, 0);
    }
  };

  private handleImeKeyUp = (e: KeyboardEvent) => {
    if (
      !this.cdp ||
      !this.wsConnected ||
      !this.currentSessionId ||
      this.isComposing ||
      e.keyCode === 229
    ) {
      return;
    }
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(e.code)) {
      e.preventDefault();
    }
    this.sendKeyEvent("keyUp", {
      windowsVirtualKeyCode: e.keyCode,
      nativeVirtualKeyCode: e.keyCode,
      key: e.key,
      code: e.code,
    });
  };

  private handleUrlKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      this.handleNavigate();
    }
  };

  private handleNavigate = () => {
    if (!this.cdp || !this.wsConnected || !this.currentSessionId) {
      return;
    }
    const input = this.shadowRoot?.querySelector(".url-bar input") as HTMLInputElement;
    if (!input) {
      return;
    }
    let url = input.value.trim();
    if (url && !url.startsWith("http")) {
      url = "https://" + url;
    }
    this.cdp.send("Page.navigate", { url }, this.currentSessionId).catch(() => {});
  };

  private connect = async () => {
    try {
      this.status = "正在连接浏览器...";
      let wsBase = this.gatewayUrl
        .replace(/^http:\/\//i, "ws://")
        .replace(/^https:\/\//i, "wss://")
        .replace(/\/+$/, "");
      if (!wsBase) {
        wsBase = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
      }
      const url = `${wsBase}/api/debug-browser-18800`;

      if (this.cdp) {
        this.cdp.close();
      }
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }

      this.status = "正在连接浏览器画面...";
      // Reset cached canvas/ctx so getCanvas() re-resolves from the current DOM ref
      this.canvas = null;
      this.ctx = null;
      this.cdp = new CDPClient(url);

      this.cdp.ws.addEventListener("open", async () => {
        this.wsConnected = true;
        this.status = "已连接 ✓";

        try {
          if (!this.cdp) {
            return;
          }
          // 启用 Target 域并开启自动附加
          await this.cdp.send("Target.setDiscoverTargets", { discover: true });

          // 获取当前所有的 targets
          const targetsRes = (await this.cdp.send("Target.getTargets")) as {
            targetInfos: { type: string; url: string; targetId: string; title?: string }[];
          };
          const pages = targetsRes.targetInfos.filter((t) => t.type === "page");

          let targetIdToAttach = "";
          if (pages.length > 0) {
            // 如果有页面，过滤掉扩展和特殊页面，优先选择普通的 web 页面
            const normalPages = pages.filter(
              (p: unknown) =>
                !(p as { url: string }).url.startsWith("chrome-extension://") &&
                !(p as { url: string }).url.startsWith("chrome://"),
            );
            if (normalPages.length > 0) {
              targetIdToAttach = normalPages[normalPages.length - 1].targetId;
            } else {
              targetIdToAttach = pages[pages.length - 1].targetId;
            }
          } else {
            const newPage = await this.cdp.send("Target.createTarget", { url: "about:blank" });
            targetIdToAttach = (newPage as { targetId: string }).targetId;
            pages.push({
              targetId: (newPage as { targetId: string }).targetId,
              type: "page",
              url: "about:blank",
              title: "New Tab",
            });
          }

          await this.cdp.send("Target.setAutoAttach", {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
          });

          // 手动附加到初始页面
          const attachRes = await this.cdp.send("Target.attachToTarget", {
            targetId: targetIdToAttach,
            flatten: true,
          });
          this.currentSessionId = (attachRes as { sessionId: string }).sessionId;

          // 更新 tabs 状态
          this.tabs = pages.map((p) => ({
            targetId: p.targetId,
            sessionId:
              p.targetId === targetIdToAttach ? (this.currentSessionId ?? undefined) : undefined,
            url: p.url,
            title: p.title || p.url,
          }));

          await this.setupPageSession(this.currentSessionId);
          this.status = "✅ 运行中 (主标签页)";

          // 监听新目标被附加（新开 Tab）
          this.cdp.on(
            "Target.attachedToTarget",
            async (params: {
              sessionId: string;
              targetInfo: { type: string; url: string; targetId: string; title?: string };
            }) => {
              const { sessionId, targetInfo } = params;
              if (targetInfo.type === "page" && sessionId !== this.currentSessionId) {
                console.log(
                  `[Target] Attached to new page: ${targetInfo.url} (Session: ${sessionId})`,
                );

                const existingTab = this.tabs.find((t) => t.targetId === targetInfo.targetId);
                if (!existingTab) {
                  this.tabs.push({
                    targetId: targetInfo.targetId,
                    sessionId: sessionId,
                    url: targetInfo.url,
                    title: targetInfo.title || targetInfo.url,
                  });
                } else {
                  existingTab.sessionId = sessionId;
                }

                this.currentSessionId = sessionId;
                await this.setupPageSession(sessionId);
                this.status = `已切换到新标签页: ${targetInfo.url || "新页面"}`;
              }
            },
          );

          this.cdp.on(
            "Target.targetInfoChanged",
            (params: {
              targetInfo: { type: string; url: string; targetId: string; title?: string };
            }) => {
              const { targetInfo } = params;
              if (targetInfo.type === "page") {
                const tab = this.tabs.find((t) => t.targetId === targetInfo.targetId);
                if (tab) {
                  tab.url = targetInfo.url;
                  tab.title = targetInfo.title || targetInfo.url;
                }
              }
            },
          );

          this.cdp.on("Target.detachedFromTarget", (params: { sessionId: string }) => {
            const { sessionId } = params;
            this.tabs = this.tabs.filter((t) => t.sessionId !== sessionId);

            if (this.currentSessionId === sessionId) {
              this.currentSessionId =
                this.tabs.length > 0 ? this.tabs[this.tabs.length - 1].sessionId || null : null;
              if (this.currentSessionId) {
                void this.setupPageSession(this.currentSessionId);
                this.status = "✅ 运行中 (已回退到上一个标签页)";
              } else {
                this.status = "⚠️ 所有标签页已关闭";
                this.clearCanvas();
              }
            }
          });

          // 接收推流事件
          this.cdp.on("Page.screencastFrame", (params: { sessionId: string; data: string }) => {
            const eventSessionId = params.sessionId;
            const data = params.data;
            const frameSessionId = params.sessionId;

            if (this.currentSessionId && eventSessionId !== this.currentSessionId) {
              this.cdp
                ?.send("Page.screencastFrameAck", { sessionId: frameSessionId }, eventSessionId)
                .catch(() => {});
              return;
            }

            const img = new Image();
            img.addEventListener("load", () => {
              const imgW = img.width;
              const imgH = img.height;
              const canvas = this.getCanvas();
              if (canvas) {
                if (canvas.width !== imgW || canvas.height !== imgH) {
                  canvas.width = imgW;
                  canvas.height = imgH;
                  this.pageMeta = { width: imgW, height: imgH };
                }
                this.ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
              }
              this.cdp
                ?.send("Page.screencastFrameAck", { sessionId: frameSessionId }, eventSessionId)
                .catch(() => {});
            });
            img.addEventListener("error", () => {
              this.cdp
                ?.send("Page.screencastFrameAck", { sessionId: frameSessionId }, eventSessionId)
                .catch(() => {});
            });
            img.src = `data:image/jpeg;base64,${data}`;
          });
        } catch (err) {
          console.error(err);
          this.status = "❌ 初始化失败";
        }
      });

      this.cdp.ws.addEventListener("close", () => {
        this.wsConnected = false;
        this.currentSessionId = null;
        this.status = "连接中断";
        this.cdp = null;
        if (this.pollInterval) {
          clearInterval(this.pollInterval);
          this.pollInterval = null;
        }
        this.clearCanvas();
      });

      this.cdp.ws.addEventListener("error", (e) => {
        console.error("WS error", e);
        this.status = "连接错误";
      });
    } catch (error) {
      console.error("Failed to connect:", error);
      this.status = `连接失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  private async setupPageSession(sessionId: string) {
    if (!sessionId || !this.cdp) {
      return;
    }

    await this.cdp.send("Page.enable", {}, sessionId);

    try {
      const tab = this.tabs.find((t) => t.sessionId === sessionId);
      if (tab) {
        const { windowId } = (await this.cdp.send("Browser.getWindowForTarget", {
          targetId: tab.targetId,
        })) as { windowId: number };
        if (windowId) {
          await this.cdp.send("Browser.setWindowBounds", {
            windowId,
            bounds: { width: this.pageMeta.width, height: this.pageMeta.height },
          });
        }
      }
      await this.cdp.send(
        "Emulation.setDeviceMetricsOverride",
        {
          width: this.pageMeta.width,
          height: this.pageMeta.height,
          deviceScaleFactor: 1,
          mobile: false,
          screenWidth: this.pageMeta.width,
          screenHeight: this.pageMeta.height,
          positionX: 0,
          positionY: 0,
          dontSetVisibleSize: false,
        },
        sessionId,
      );
    } catch (err) {
      console.warn("当前目标不支持设置视口大小", err);
    }

    await this.cdp.send("Page.bringToFront", {}, sessionId).catch(() => {});

    try {
      await this.cdp.send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: 80,
          everyNthFrame: 1,
        },
        sessionId,
      );
    } catch (err) {
      console.warn("当前目标不支持投屏", err);
    }

    this.startPollingScreenshot(sessionId);
  }

  private startPollingScreenshot(sessionId: string) {
    if (this.pollInterval) {
      window.clearInterval(this.pollInterval);
    }
    this.pollInterval = window.setInterval(async () => {
      if (!this.cdp || !this.wsConnected || this.currentSessionId !== sessionId) {
        if (this.pollInterval) {
          window.clearInterval(this.pollInterval);
          this.pollInterval = null;
        }
        return;
      }
      try {
        const res = await this.cdp.send(
          "Page.captureScreenshot",
          { format: "jpeg", quality: 50 },
          sessionId,
        );
        if (res && (res as { data?: string }).data && this.currentSessionId === sessionId) {
          const img = new Image();
          img.addEventListener("load", () => {
            const canvas = this.getCanvas();
            if (canvas && this.ctx) {
              this.ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            }
          });
          img.src = `data:image/jpeg;base64,${(res as { data: string }).data}`;
        }
      } catch {
        // 忽略错误
      }
    }, 1000 / 30);
  }

  private clearCanvas() {
    const canvas = this.getCanvas();
    const ctx = this.ctx;
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  private disconnect() {
    if (this.cdp) {
      this.cdp.close();
      this.cdp = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private handleDragStart = (e: MouseEvent) => {
    if (this.isResizing) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    this.cleanupDragListeners();
    this.isDragging = true;
    this.dragStart = { x: e.clientX, y: e.clientY };
    this.tempIsFloating = this.isFloating;
    const screen = this.shadowRoot?.querySelector(".screen") as HTMLDivElement | null;
    const dragHandle = this.shadowRoot?.querySelector(".drag-handle") as HTMLDivElement | null;
    if (screen && dragHandle) {
      screen.classList.add("dragging");
      const dragHandleRect = dragHandle.getBoundingClientRect();
      this.dragAnchor = { x: e.clientX - dragHandleRect.left, y: e.clientY - dragHandleRect.top };
      const rect = screen.getBoundingClientRect();
      const hostRect = this.getBoundingClientRect();
      this.initialRect = {
        x: this.isFloating ? this.floatingRect.x : rect.left,
        y: this.isFloating ? this.floatingRect.y : rect.top,
        width: screen.offsetWidth,
        height: screen.offsetHeight,
        offsetY: this.dockedOffsetY,
        offsetX: this.dockedOffsetX,
        containerHeight: hostRect.height,
        containerTop: hostRect.top,
        containerLeft: hostRect.left,
        containerWidth: this.offsetWidth,
      };
      if (!this.isFloating) {
        this.floatingRect = {
          x: rect.left,
          y: rect.top,
          width: screen.offsetWidth,
          height: screen.offsetHeight,
        };
      }
    }
    window.addEventListener("mousemove", this.handleDragMove, { capture: true, passive: false });
    window.addEventListener("mouseup", this.handleDragEnd, { capture: true });
  };

  private handleDragMove = (e: MouseEvent) => {
    if (!this.isDragging) {
      return;
    }
    if (e.buttons !== 1) {
      this.cleanupDragListeners();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const dx = e.clientX - this.dragStart.x;
    const dy = e.clientY - this.dragStart.y;
    const hostRect = this.getBoundingClientRect();
    if (e.clientX < hostRect.left) {
      if (!this.tempIsFloating) {
        this.tempIsFloating = true;
        this.floatingRect = {
          x: e.clientX - this.dragAnchor.x,
          y: e.clientY - this.dragAnchor.y,
          width: this.initialRect.width,
          height: this.initialRect.height,
        };
        this.initialRect = { ...this.initialRect, x: this.floatingRect.x, y: this.floatingRect.y };
        this.dragStart = { x: e.clientX, y: e.clientY };
      }
    } else {
      if (this.tempIsFloating) {
        this.tempIsFloating = false;
        this.dockedOffsetY = this.initialRect.offsetY;
        this.dockedOffsetX = 0;
        this.dragStart = { x: e.clientX, y: e.clientY };
      }
    }
    if (this.tempIsFloating) {
      let newX = this.initialRect.x + dx;
      let newY = this.initialRect.y + dy;
      newX = Math.max(0, Math.min(newX, window.innerWidth - this.initialRect.width));
      newY = Math.max(0, Math.min(newY, window.innerHeight - this.initialRect.height));
      this.floatingRect = { ...this.floatingRect, x: newX, y: newY };
    } else {
      const hostHeight = this.offsetHeight;
      const screen = this.shadowRoot?.querySelector(".screen") as HTMLDivElement | null;
      const screenHeight = screen?.offsetHeight || 0;
      const container = this.shadowRoot?.querySelector(".screen-container");
      const style = container ? getComputedStyle(container) : null;
      const paddingTop = style ? parseFloat(style.paddingTop) || 0 : 50;
      const contentHeight = hostHeight - paddingTop;
      const centerTop = (contentHeight - screenHeight) / 2;
      const maxUpOffset = -centerTop;
      const maxDownOffset = centerTop;
      let newOffsetY = this.initialRect.offsetY + dy;
      newOffsetY = Math.max(maxUpOffset, Math.min(newOffsetY, maxDownOffset));
      this.dockedOffsetY = newOffsetY;
      this.dockedOffsetX = 0;
    }
  };

  private cleanupDragListeners = () => {
    this.isDragging = false;
    const screen = this.shadowRoot?.querySelector(".screen") as HTMLDivElement | null;
    if (screen) {
      screen.classList.remove("dragging");
    }
    try {
      window.removeEventListener("mousemove", this.handleDragMove, { capture: true });
      window.removeEventListener("mouseup", this.handleDragEnd, { capture: true });
    } catch (e) {
      console.error("Error removing drag listeners:", e);
    }
  };

  private handleDragEnd = (e: MouseEvent) => {
    const hostRect = this.getBoundingClientRect();
    const isDroppingInDockArea = e.clientX >= hostRect.left;
    if (!isDroppingInDockArea) {
      if (!this.isFloating) {
        this.isFloating = true;
        this.dispatchEvent(new CustomEvent("float", { bubbles: true, composed: true }));
      }
    } else {
      if (this.isFloating) {
        this.isFloating = false;
        this.dockedOffsetX = 0;
        this.dispatchEvent(new CustomEvent("dock", { bubbles: true, composed: true }));
      } else {
        this.isFloating = false;
        this.dockedOffsetX = 0;
      }
    }
    this.cleanupDragListeners();
  };

  private cleanupResizeListeners = () => {
    this.isResizing = false;
    try {
      window.removeEventListener("mousemove", this.handleResizeMove);
      window.removeEventListener("mouseup", this.handleResizeEnd);
    } catch (e) {
      console.error("Error removing resize listeners:", e);
    }
  };

  private handleResizeStart = (e: MouseEvent, edge: string) => {
    e.preventDefault();
    e.stopPropagation();
    this.cleanupResizeListeners();
    this.isResizing = true;
    this.resizeEdge = edge;
    this.dragStart = { x: e.clientX, y: e.clientY };
    this.initialRect = {
      x: this.floatingRect.x,
      y: this.floatingRect.y,
      width: this.floatingRect.width,
      height: this.floatingRect.height,
      offsetY: 0,
      offsetX: 0,
      containerHeight: 0,
      containerTop: 0,
      containerLeft: 0,
      containerWidth: 0,
    };
    this.aspectRatio = this.floatingRect.width / this.floatingRect.height;
    window.addEventListener("mousemove", this.handleResizeMove);
    window.addEventListener("mouseup", this.handleResizeEnd);
  };

  private handleResizeMove = (e: MouseEvent) => {
    if (!this.isResizing) {
      return;
    }
    if (e.buttons !== 1) {
      this.cleanupResizeListeners();
      return;
    }
    e.preventDefault();
    const dx = e.clientX - this.dragStart.x;
    const dy = e.clientY - this.dragStart.y;
    let { x, y, width, height } = this.initialRect;
    if (this.resizeEdge.includes("right")) {
      width += dx;
    }
    if (this.resizeEdge.includes("left")) {
      x += dx;
      width -= dx;
    }
    if (this.resizeEdge.includes("bottom")) {
      height += dy;
    }
    if (this.resizeEdge.includes("top")) {
      y += dy;
      height -= dy;
    }
    if (width < 200) {
      width = 200;
      if (this.resizeEdge.includes("left")) {
        x = this.initialRect.x + (this.initialRect.width - width);
      }
    }
    if (height < 150) {
      height = 150;
      if (this.resizeEdge.includes("top")) {
        y = this.initialRect.y + (this.initialRect.height - height);
      }
    }
    this.floatingRect = { x, y, width, height };
  };

  private handleResizeEnd = () => {
    this.cleanupResizeListeners();
  };

  private handleClose = () => {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  };

  private setActiveTool(tool: string) {
    this.dispatchEvent(
      new CustomEvent("tool-change", { detail: { tool }, bubbles: true, composed: true }),
    );
  }

  private toggleFullscreen = () => {
    const container = this.shadowRoot?.querySelector(".screen-container");
    if (container) {
      void (container as HTMLElement).requestFullscreen?.();
    }
  };

  private handleWindowBlur = () => {
    this.cleanupDragListeners();
    this.cleanupResizeListeners();
  };

  private handleResize = () => {};

  firstUpdated() {
    window.addEventListener("resize", this.handleResize);
    window.addEventListener("blur", this.handleWindowBlur);
    this.setupResizeObserver();
    if (this.enabled) {
      setTimeout(() => void this.connect(), 100);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("resize", this.handleResize);
    window.removeEventListener("blur", this.handleWindowBlur);
    this.cleanupDragListeners();
    this.cleanupResizeListeners();
    this.setupResizeObserver();
    this.disconnect();
  }
}
