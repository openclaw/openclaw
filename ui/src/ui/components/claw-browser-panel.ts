import { LitElement, html, css, type PropertyValues } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { createRef, ref, type Ref } from "lit/directives/ref.js";

interface TabInfo {
  targetId: string;
  sessionId?: string;
  url: string;
  title: string;
}

interface CDPResponse<T = unknown> {
  id?: number;
  result?: T;
  error?: unknown;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

class CDPClient {
  public ws: WebSocket;
  private messageId = 0;
  private pendingPromises = new Map<
    number,
    { resolve: (res: unknown) => void; reject: (err: unknown) => void }
  >();
  private eventHandlers = new Map<string, Set<Function>>();

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", this.handleMessage.bind(this));
  }

  private handleMessage(event: MessageEvent) {
    try {
      const msg = JSON.parse(event.data as string) as CDPResponse;
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
          msg.params = msg.params || {};
          // 为了不覆盖原本 params 里的属性（例如 screencast 的 integer sessionId）
          // 我们将外层的 target Session ID 存为 targetSessionId
          if (msg.sessionId) {
            msg.params.targetSessionId = msg.sessionId;
          }
          handlers.forEach((fn) => fn(msg.params));
        }
      }
    } catch {
      // 忽略解析错误
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
  @property({ type: String }) browserPort = "19221";
  @property({ type: Number }) browserWidth = 1280;
  @property({ type: Number }) browserHeight = 720;

  @state() status = "等待连接...";
  @state() wsConnected = false;
  @state() currentUrl = "https://www.google.com";
  @state() tabs: TabInfo[] = [];

  @state() private isFloating = false;
  @state() private dockedOffsetY = 0;
  @state() private dockedOffsetX = 0;
  @state() private floatingRect = { x: 0, y: 0, width: 800, height: 600 };

  private canvasRef: Ref<HTMLCanvasElement> = createRef<HTMLCanvasElement>();
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  private cdp: CDPClient | null = null;
  private currentSessionId: string | null = null;
  private pollInterval: number | null = null;

  private pageMeta = { width: 1280, height: 720 };
  private isMouseDown = false;
  private lastMouseMoveTime = 0;
  private isComposing = false;
  private imeInput: HTMLTextAreaElement | null = null;

  private tempIsFloating = false;
  private dragStart = { x: 0, y: 0 };
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
    const container = this.shadowRoot.querySelector(".screen-container");
    if (!container) {
      return;
    }
    const style = getComputedStyle(container);
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const contentHeight = hostHeight - paddingTop;
    const centerTop = (contentHeight - screenHeight) / 2;
    const maxOffset = Math.max(0, centerTop);
    if (Math.abs(this.dockedOffsetY) > maxOffset) {
      this.dockedOffsetY = Math.max(-maxOffset, Math.min(maxOffset, this.dockedOffsetY));
    }
  }

  protected updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);
    const connectionDepsChanged =
      changedProperties.has("enabled") ||
      changedProperties.has("browserPort") ||
      changedProperties.has("gatewayUrl");

    if (connectionDepsChanged) {
      if (this.enabled) {
        // If port or url changed while connected, reconnect
        if (
          this.wsConnected &&
          (changedProperties.has("browserPort") || changedProperties.has("gatewayUrl"))
        ) {
          this.disconnect();
          setTimeout(() => void this.connect(), 100);
        } else if (!this.wsConnected) {
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
    .container {
      height: 100%;
      display: flex;
      flex-direction: column;
      position: relative;
    }

    .browser-controls {
      background: var(--card);
      border-bottom: 1px solid var(--border);
      padding: 8px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 101;
    }
    .control-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .control-row label {
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
    }
    .control-row input {
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-accent);
      color: var(--text);
      font-size: 12px;
      outline: none;
    }
    .port-input {
      width: 60px;
    }
    .url-input {
      flex: 1;
    }
    .control-row button {
      padding: 4px 12px;
      border: none;
      border-radius: 4px;
      background: var(--accent);
      color: white;
      font-size: 12px;
      cursor: pointer;
    }
    .control-row button:hover {
      opacity: 0.9;
    }
    .control-row button:disabled {
      background: var(--muted);
      cursor: not-allowed;
    }
    .status-text {
      font-size: 11px;
      color: var(--muted);
      margin-left: 4px;
    }

    .tabs-bar {
      display: flex;
      gap: 4px;
      overflow-x: auto;
      padding: 2px 0;
    }
    .tab-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: var(--bg-accent);
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      max-width: 150px;
      white-space: nowrap;
      color: var(--muted);
    }
    .tab-item.active {
      background: var(--accent);
      color: white;
      border-color: var(--accent);
    }
    .tab-title {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tab-close {
      opacity: 0.6;
      font-size: 14px;
      line-height: 1;
    }
    .tab-close:hover {
      opacity: 1;
      color: #ff5f56;
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
    .screen.dragging canvas {
      pointer-events: none !important;
    }
    .screen canvas {
      max-width: 100% !important;
      max-height: 100% !important;
      width: auto !important;
      height: auto !important;
      outline: none;
      display: block;
      margin: auto !important;
      background: #000;
      border-radius: 0;
      box-shadow: none;
      pointer-events: auto !important;
      cursor: crosshair;
      z-index: 10;
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
      background: transparent;
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
    .resize-handle.bottom-right {
      bottom: -5px;
      right: -5px;
      width: 15px;
      height: 15px;
      cursor: nwse-resize;
      z-index: 35;
    }
  `;

  render() {
    const displayFloating = this.isDragging ? this.tempIsFloating : this.isFloating;
    const screenStyle = displayFloating
      ? `transform: translate(${this.floatingRect.x}px, ${this.floatingRect.y}px); width: ${this.floatingRect.width}px; height: ${this.floatingRect.height}px;`
      : `transform: translate(${this.dockedOffsetX}px, ${this.dockedOffsetY}px);`;

    return html`
      <div class="container" tabindex="0">
        <div class="browser-controls">
          <div class="control-row">
            <button @click=${() => void this.connect()} ?disabled=${this.wsConnected}>连接</button>
            <button @click=${() => this.disconnect()} ?disabled=${!this.wsConnected}>断开</button>
            <span class="status-text">${this.status} (端口: ${this.browserPort})</span>
          </div>
          <div class="control-row">
            <input 
              class="url-input" 
              .value=${this.currentUrl} 
              @input=${(e: Event) => {
                this.currentUrl = (e.target as HTMLInputElement).value;
              }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") {
                  void this.handleNavigate();
                }
              }}
              placeholder="输入网址跳转"
            />
            <button @click=${() => void this.handleNavigate()} ?disabled=${!this.wsConnected}>跳转</button>
            <button @click=${() => void this.handleNewTab()} ?disabled=${!this.wsConnected}>新标签页</button>
          </div>
          <div class="tabs-bar">
            ${this.tabs.map(
              (tab) => html`
              <div 
                class="tab-item ${tab.sessionId === this.currentSessionId ? "active" : ""}" 
                @click=${() => void this.switchTab(tab)}
              >
                <span class="tab-title" title=${tab.url}>${tab.title || tab.url || "New Tab"}</span>
                <span class="tab-close" @click=${(e: Event) => void this.handleCloseTab(e, tab)}>×</span>
              </div>
            `,
            )}
          </div>
        </div>

        <div class="screen-container">
          ${
            !displayFloating
              ? html`
            <div class="top-toolbar">
              <button
                class="toolbar-btn ${this.activeTool === "vnc" ? "active" : ""}"
                @click=${() => this.setActiveTool("vnc")}
              >
                <svg viewBox="0 0 24 24"><rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" /></svg>
              </button>
              <button
                class="toolbar-btn ${this.activeTool === "browser" ? "active" : ""}"
                @click=${() => this.setActiveTool("browser")}
              >
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><line x1="2" x2="22" y1="12" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
              </button>
              <button
                class="toolbar-btn ${this.activeTool === "images" ? "active" : ""}"
                @click=${() => this.setActiveTool("images")}
              >
                <svg viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></svg>
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
              @wheel=${{ handleEvent: this.handleWheel, passive: false }}
              @click=${() => this.getImeInput()?.focus()}
            ></canvas>
            <textarea
              id="ime-input"
              style="position:absolute; opacity:0; pointer-events:none; width:1px; height:1px;"
              @compositionstart=${() => {
                this.isComposing = true;
              }}
              @compositionend=${this.handleCompositionEnd}
              @input=${this.handleImeInput}
              @keydown=${this.handleImeKeyDown}
              @keyup=${this.handleImeKeyUp}
            ></textarea>
            <div class="drag-handle" @mousedown=${this.handleDragStart}></div>
            <div class="window-controls">
              <div class="window-control close" @click=${() => this.dispatchEvent(new CustomEvent("close"))}></div>
              <div class="window-control minimize"></div>
              <div class="window-control maximize" @click=${() => {
                void (
                  this.shadowRoot?.querySelector(".screen-container") as HTMLElement
                )?.requestFullscreen();
              }}></div>
            </div>
            ${displayFloating ? html`<div class="resize-handle bottom-right" @mousedown=${(e: MouseEvent) => this.handleResizeStart(e, "bottom-right")}></div>` : null}
          </div>
        </div>
      </div>
    `;
  }

  private getCanvas() {
    if (this.canvas) {
      return this.canvas;
    }
    if (this.canvasRef?.value) {
      this.canvas = this.canvasRef.value;
      this.ctx = this.canvas.getContext("2d");
    }
    return this.canvas;
  }

  private getImeInput() {
    if (this.imeInput) {
      return this.imeInput;
    }
    if (this.shadowRoot) {
      this.imeInput = this.shadowRoot.querySelector("#ime-input") as HTMLTextAreaElement;
    }
    return this.imeInput;
  }

  private getMousePos(e: MouseEvent) {
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

  private renderCount = 0;

  private async connect() {
    try {
      this.status = "正在连接浏览器...";
      this.renderCount = 0;
      let wsBase = this.gatewayUrl.replace(/^http/i, "ws").replace(/\/+$/, "");
      if (!wsBase) {
        wsBase = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
      }

      const url = `${wsBase}/api/debug-browser-${this.browserPort}`;
      console.log(`[CDP] Connecting to: ${url}`);
      if (this.cdp) {
        this.cdp.close();
      }
      this.cdp = new CDPClient(url);

      const currentCdp = this.cdp;

      currentCdp.ws.addEventListener("open", () => {
        void (async () => {
          // 确保仍然是当前活跃的连接
          if (this.cdp !== currentCdp) {
            return;
          }
          this.wsConnected = true;
          this.status = "已连接 ✓";

          try {
            await currentCdp.send("Target.setDiscoverTargets", { discover: true });
            const res = (await currentCdp.send("Target.getTargets")) as {
              targetInfos: { type: string; url: string; targetId: string; title?: string }[];
            };
            const pages = res.targetInfos.filter((t) => t.type === "page");

            let targetId = "";
            if (pages.length > 0) {
              // 优先选 Google 或非空页面
              const preferred = pages.find(
                (p) =>
                  p.url.includes("google") ||
                  (p.url !== "about:blank" && !p.url.startsWith("chrome")),
              );
              targetId = preferred ? preferred.targetId : pages[pages.length - 1].targetId;
            } else {
              const newTarget = (await currentCdp.send("Target.createTarget", {
                url: "about:blank",
              })) as { targetId: string };
              targetId = newTarget.targetId;
            }

            await currentCdp.send("Target.setAutoAttach", {
              autoAttach: true,
              waitForDebuggerOnStart: false,
              flatten: true,
            });
            const attach = (await currentCdp.send("Target.attachToTarget", {
              targetId,
              flatten: true,
            })) as { sessionId: string };
            this.currentSessionId = attach.sessionId;

            this.tabs = pages.map((p) => ({
              targetId: p.targetId,
              sessionId: p.targetId === targetId ? attach.sessionId : undefined,
              url: p.url,
              title: p.title || p.url,
            }));
            await this.setupPageSession(this.currentSessionId);
            this.status = "✅ 运行中 (准备接收画面)";

            currentCdp.on(
              "Target.attachedToTarget",
              (params: {
                sessionId: string;
                targetInfo: { type: string; url: string; targetId: string; title?: string };
              }) => {
                void (async () => {
                  if (this.cdp !== currentCdp) {
                    return;
                  }
                  const { sessionId, targetInfo } = params;
                  if (targetInfo.type === "page" && sessionId !== this.currentSessionId) {
                    const existing = this.tabs.find((t) => t.targetId === targetInfo.targetId);
                    if (!existing) {
                      this.tabs = [
                        ...this.tabs,
                        {
                          targetId: targetInfo.targetId,
                          sessionId,
                          url: targetInfo.url,
                          title: targetInfo.title || targetInfo.url,
                        },
                      ];
                    } else {
                      existing.sessionId = sessionId;
                    }
                    this.currentSessionId = sessionId;
                    await this.setupPageSession(sessionId);
                    this.requestUpdate();
                  }
                })();
              },
            );

            currentCdp.on(
              "Target.targetInfoChanged",
              (params: {
                targetInfo: { type: string; url: string; targetId: string; title?: string };
              }) => {
                if (this.cdp !== currentCdp) {
                  return;
                }
                const { targetInfo } = params;
                const tab = this.tabs.find((t) => t.targetId === targetInfo.targetId);
                if (tab) {
                  tab.url = targetInfo.url;
                  tab.title = targetInfo.title || targetInfo.url;
                  this.requestUpdate();
                }
              },
            );

            currentCdp.on("Target.detachedFromTarget", (params: { sessionId: string }) => {
              if (this.cdp !== currentCdp) {
                return;
              }
              this.tabs = this.tabs.filter((t) => t.sessionId !== params.sessionId);
              if (this.currentSessionId === params.sessionId) {
                const next = this.tabs[this.tabs.length - 1];
                this.currentSessionId = next ? next.sessionId || null : null;
                if (this.currentSessionId) {
                  void this.setupPageSession(this.currentSessionId);
                } else {
                  this.clearCanvas();
                }
              }
              this.requestUpdate();
            });

            currentCdp.on(
              "Page.screencastFrame",
              (params: {
                sessionId: number;
                targetSessionId?: string;
                data: string;
                metadata: unknown;
              }) => {
                if (this.cdp !== currentCdp) {
                  return;
                }
                const { sessionId: frameSessionId, targetSessionId, data } = params;
                const eventSessionId = targetSessionId;

                if (
                  this.currentSessionId &&
                  eventSessionId &&
                  eventSessionId !== this.currentSessionId
                ) {
                  void currentCdp
                    .send("Page.screencastFrameAck", { sessionId: frameSessionId }, eventSessionId)
                    .catch(() => {});
                  return;
                }

                const img = new Image();
                img.addEventListener("load", () => {
                  if (this.cdp !== currentCdp) {
                    return;
                  }
                  const canvas = this.getCanvas();
                  if (canvas) {
                    if (canvas.width !== img.width || canvas.height !== img.height) {
                      canvas.width = img.width;
                      canvas.height = img.height;
                      this.pageMeta = { width: img.width, height: img.height };
                    }
                    const ctx = canvas.getContext("2d");
                    if (ctx) {
                      ctx.drawImage(img, 0, 0);
                      this.renderCount++;
                      if (this.renderCount % 10 === 0) {
                        this.status = `✅ 运行中 (已接收 ${this.renderCount} 帧)`;
                      }
                    }
                  }
                  void currentCdp
                    .send("Page.screencastFrameAck", { sessionId: frameSessionId }, eventSessionId)
                    .catch(() => {});
                });
                img.addEventListener("error", () => {
                  void currentCdp
                    .send("Page.screencastFrameAck", { sessionId: frameSessionId }, eventSessionId)
                    .catch(() => {});
                });
                img.src = `data:image/jpeg;base64,${data}`;
              },
            );
          } catch (e) {
            this.status = `❌ 初始化失败: ${e instanceof Error ? e.message : String(e)} (端口: ${this.browserPort})`;
          }
        })();
      });

      currentCdp.ws.addEventListener("close", () => {
        if (this.cdp === currentCdp) {
          this.wsConnected = false;
          this.currentSessionId = null;
          this.status = "连接中断";
          this.cdp = null;
          this.clearCanvas();
        }
      });
    } catch {
      this.status = "连接失败";
    }
  }

  private async setupPageSession(sessionId: string) {
    await this.cdp!.send("Page.enable", {}, sessionId);
    try {
      // 强制设置视口，确保有内容渲染
      await this.cdp!.send(
        "Emulation.setDeviceMetricsOverride",
        {
          width: this.browserWidth,
          height: this.browserHeight,
          deviceScaleFactor: 1,
          mobile: false,
          screenWidth: this.browserWidth,
          screenHeight: this.browserHeight,
          positionX: 0,
          positionY: 0,
          dontSetVisibleSize: false,
        },
        sessionId,
      );
    } catch {
      // 忽略
    }
    await this.cdp!.send("Page.bringToFront", {}, sessionId).catch(() => {});
    try {
      // 停止之前的 screencast (如果有)
      await this.cdp!.send("Page.stopScreencast", {}, sessionId).catch(() => {});
      // 开启新的 screencast
      await this.cdp!.send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: 80,
          everyNthFrame: 1,
          maxWidth: this.browserWidth,
          maxHeight: this.browserHeight,
        },
        sessionId,
      );
    } catch {
      // 忽略
    }
    // 移除之前的 polling 逻辑，完全依赖 screencast 提高效率
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private startPollingScreenshot(sessionId: string) {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    this.pollInterval = window.setInterval(async () => {
      if (!this.cdp || !this.wsConnected || this.currentSessionId !== sessionId) {
        if (this.pollInterval) {
          clearInterval(this.pollInterval);
          this.pollInterval = null;
        }
        return;
      }
      try {
        const res = (await this.cdp.send(
          "Page.captureScreenshot",
          { format: "jpeg", quality: 50 },
          sessionId,
        )) as { data: string };
        if (res?.data && this.currentSessionId === sessionId) {
          const img = new Image();
          img.addEventListener("load", () => {
            const canvas = this.getCanvas();
            if (canvas && this.ctx) {
              this.ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            }
          });
          img.src = `data:image/jpeg;base64,${res.data}`;
        }
      } catch {
        // 忽略
      }
    }, 500);
  }

  private disconnect() {
    if (this.cdp) {
      this.cdp.close();
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
  }

  private clearCanvas() {
    const canvas = this.getCanvas();
    if (canvas && this.ctx) {
      this.ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  private async switchTab(tab: TabInfo) {
    if (tab.sessionId === this.currentSessionId) {
      return;
    }
    if (!tab.sessionId) {
      const res = (await this.cdp!.send("Target.attachToTarget", {
        targetId: tab.targetId,
        flatten: true,
      })) as { sessionId: string };
      tab.sessionId = res.sessionId;
    }
    this.currentSessionId = tab.sessionId;
    await this.setupPageSession(this.currentSessionId);
    this.requestUpdate();
  }

  private async handleCloseTab(e: Event, tab: TabInfo) {
    e.stopPropagation();
    await this.cdp!.send("Target.closeTarget", { targetId: tab.targetId });
  }

  private async handleNavigate() {
    if (!this.cdp || !this.currentSessionId) {
      return;
    }
    let url = this.currentUrl.trim();
    if (url && !url.startsWith("http")) {
      url = "https://" + url;
    }
    await this.cdp.send("Page.navigate", { url }, this.currentSessionId).catch(() => {});
  }

  private async handleNewTab() {
    if (!this.cdp) {
      return;
    }
    await this.cdp.send("Target.createTarget", { url: "about:blank" });
  }

  private sendMouseEvent(
    type: string,
    x: number,
    y: number,
    button: string = "left",
    clickCount?: number,
  ) {
    if (!this.cdp || !this.currentSessionId) {
      return;
    }
    const params: Record<string, unknown> = { type, x, y, button };
    if (clickCount !== undefined) {
      params.clickCount = clickCount;
    }
    void this.cdp.send("Input.dispatchMouseEvent", params, this.currentSessionId).catch(() => {});
  }

  private handleMouseDown = (e: MouseEvent) => {
    const pos = this.getMousePos(e);
    if (!pos) {
      return;
    }
    this.isMouseDown = true;
    this.getImeInput()?.focus();
    this.sendMouseEvent("mousePressed", pos.x, pos.y, "left", 1);
  };

  private handleMouseUp = (e: MouseEvent) => {
    const pos = this.getMousePos(e);
    if (!pos) {
      return;
    }
    this.isMouseDown = false;
    this.sendMouseEvent("mouseReleased", pos.x, pos.y, "left", 1);
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
    this.sendMouseEvent("mouseMoved", pos.x, pos.y, this.isMouseDown ? "left" : "none");
  };

  private handleWheel = (e: WheelEvent) => {
    const pos = this.getMousePos(e);
    if (!pos) {
      return;
    }
    // 阻止事件冒泡和默认行为，防止触发全局页面的滚动
    e.preventDefault();
    e.stopPropagation();

    if (this.cdp && this.currentSessionId) {
      void this.cdp
        .send(
          "Input.dispatchMouseEvent",
          { type: "mouseWheel", x: pos.x, y: pos.y, deltaX: e.deltaX, deltaY: e.deltaY },
          this.currentSessionId,
        )
        .catch(() => {});
    }
  };

  private handleCompositionEnd = (e: CompositionEvent) => {
    this.isComposing = false;
    if (e.data && this.cdp && this.currentSessionId) {
      void this.cdp
        .send("Input.insertText", { text: e.data }, this.currentSessionId)
        .catch(() => {});
    }
    const ime = this.getImeInput();
    if (ime) {
      ime.value = "";
    }
  };

  private handleImeInput = (e: Event) => {
    if (this.isComposing || !this.cdp || !this.wsConnected || !this.currentSessionId) {
      return;
    }
    const target = e.target as HTMLTextAreaElement;
    const val = target.value;
    // 对于非输入法产生的 input（例如粘贴），如果是多字符，也用 insertText
    if (val.length > 1) {
      void this.cdp.send("Input.insertText", { text: val }, this.currentSessionId).catch(() => {});
      target.value = "";
    }
  };

  private handleImeKeyDown = (e: KeyboardEvent) => {
    if (!this.cdp || !this.currentSessionId || this.isComposing || e.keyCode === 229) {
      return;
    }

    // 阻止某些键的默认行为
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(e.code)) {
      e.preventDefault();
    }

    const text = e.key.length === 1 ? e.key : undefined;
    void this.cdp
      .send(
        "Input.dispatchKeyEvent",
        {
          type: text ? "keyDown" : "rawKeyDown",
          windowsVirtualKeyCode: e.keyCode,
          nativeVirtualKeyCode: e.keyCode,
          key: e.key,
          code: e.code,
          text,
          unmodifiedText: text,
        },
        this.currentSessionId,
      )
      .catch(() => {});

    // 如果是单字符输入，清空 textarea 防止堆积导致重复发送
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
    if (!this.cdp || !this.currentSessionId || this.isComposing || e.keyCode === 229) {
      return;
    }
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(e.code)) {
      e.preventDefault();
    }
    void this.cdp
      .send(
        "Input.dispatchKeyEvent",
        {
          type: "keyUp",
          windowsVirtualKeyCode: e.keyCode,
          nativeVirtualKeyCode: e.keyCode,
          key: e.key,
          code: e.code,
        },
        this.currentSessionId,
      )
      .catch(() => {});
  };

  private handleDragStart = (e: MouseEvent) => {
    if (this.isResizing) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    this.isDragging = true;
    this.dragStart = { x: e.clientX, y: e.clientY };
    this.tempIsFloating = this.isFloating;
    const screen = this.shadowRoot?.querySelector(".screen") as HTMLElement;
    if (screen) {
      screen.classList.add("dragging");
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
    }
    window.addEventListener("mousemove", this.handleDragMove, { capture: true, passive: false });
    window.addEventListener("mouseup", this.handleDragEnd, { capture: true });
  };

  private handleDragMove = (e: MouseEvent) => {
    if (!this.isDragging) {
      return;
    }
    const dx = e.clientX - this.dragStart.x;
    const dy = e.clientY - this.dragStart.y;
    const hostRect = this.getBoundingClientRect();
    if (e.clientX < hostRect.left) {
      if (!this.tempIsFloating) {
        this.tempIsFloating = true;
        this.floatingRect = {
          x: e.clientX - 50,
          y: e.clientY - 15,
          width: this.initialRect.width,
          height: this.initialRect.height,
        };
      }
      this.floatingRect = {
        ...this.floatingRect,
        x: this.initialRect.x + dx,
        y: this.initialRect.y + dy,
      };
    } else {
      if (this.tempIsFloating) {
        this.tempIsFloating = false;
        this.dockedOffsetY = this.initialRect.offsetY;
      }
      this.dockedOffsetY = Math.max(-300, Math.min(300, this.initialRect.offsetY + dy));
    }
  };

  private handleDragEnd = () => {
    this.isDragging = false;
    this.isFloating = this.tempIsFloating;
    this.shadowRoot?.querySelector(".screen")?.classList.remove("dragging");
    window.removeEventListener("mousemove", this.handleDragMove, { capture: true });
    window.removeEventListener("mouseup", this.handleDragEnd, { capture: true });
  };

  private handleResizeStart = (e: MouseEvent, edge: string) => {
    e.preventDefault();
    e.stopPropagation();
    this.isResizing = true;
    this.resizeEdge = edge;
    this.dragStart = { x: e.clientX, y: e.clientY };
    this.initialRect = {
      ...this.initialRect,
      width: this.floatingRect.width,
      height: this.floatingRect.height,
    };
    window.addEventListener("mousemove", this.handleResizeMove);
    window.addEventListener("mouseup", this.handleResizeEnd);
  };

  private handleResizeMove = (e: MouseEvent) => {
    if (!this.isResizing) {
      return;
    }
    const dx = e.clientX - this.dragStart.x;
    const dy = e.clientY - this.dragStart.y;
    this.floatingRect = {
      ...this.floatingRect,
      width: Math.max(200, this.initialRect.width + dx),
      height: Math.max(150, this.initialRect.height + dy),
    };
  };

  private handleResizeEnd = () => {
    this.isResizing = false;
    window.removeEventListener("mousemove", this.handleResizeMove);
    window.removeEventListener("mouseup", this.handleResizeEnd);
  };

  private setActiveTool(tool: string) {
    this.dispatchEvent(
      new CustomEvent("tool-change", { detail: { tool }, bubbles: true, composed: true }),
    );
  }

  firstUpdated() {
    this.setupResizeObserver();
    if (this.enabled) {
      setTimeout(() => void this.connect(), 100);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.disconnect();
  }
}
