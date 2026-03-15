// @ts-ignore - noVNC types are not available
import RFB from "@novnc/novnc";
import { LitElement, html, css } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { createRef, ref, Ref } from "lit/directives/ref.js";

// Compatible with both .default and non-.default versions
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RFBClass = (RFB as any).default || RFB;

// RFB instance type definition
interface RFBInstance {
  disconnect(): void;
  addEventListener(event: string, callback: (e: unknown) => void): void;
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

  // Floating window state
  @state() private isFloating = false;
  @state() private dockedOffsetY = 0;
  @state() private dockedOffsetX = 0;
  @state() private floatingRect = { x: 0, y: 0, width: 600, height: 400 };

  private rfb: RFBInstance | null = null;
  private screenRef: Ref<HTMLDivElement> = createRef<HTMLDivElement>();
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
  private aspectRatio = 1;
  // 记录拖拽开始时鼠标相对于拖拽句柄的位置（点 A）
  private dragAnchor = { x: 0, y: 0 };
  // 拖拽过程中的临时悬浮状态
  private tempIsFloating = false;
  // canvas 的比例（用于悬浮模式缩放时保持）
  private canvasRatio = 16 / 9;

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

    .screen canvas {
      max-width: 100% !important;
      max-height: 100% !important;
      width: auto !important;
      height: auto !important;
      outline: none;
      display: block;
      margin: auto !important;
      border-radius: 0;
      box-shadow: none;
      pointer-events: auto !important;
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
  `;

  render() {
    const displayFloating = this.isDragging ? this.tempIsFloating : this.isFloating;
    const screenStyle = displayFloating
      ? `transform: translate(${this.floatingRect.x}px, ${this.floatingRect.y}px); width: ${this.floatingRect.width}px; height: ${this.floatingRect.height}px;`
      : `transform: translate(${this.dockedOffsetX}px, ${this.dockedOffsetY}px);`;

    return html`
      <div class="container">
        ${!this.isConnected ? html`<div class="status-overlay">${this.status}</div>` : null}
        <div class="screen-container">
          <div
            ${ref(this.screenRef)}
            class="screen ${displayFloating ? "floating" : ""}"
            style="${screenStyle}"
          >
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

  private handleClose = () => {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  };

  private handleDragStart = (e: MouseEvent) => {
    if (this.isResizing) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    // 先清理旧的监听器，防止重复添加
    this.cleanupDragListeners();

    this.isDragging = true;
    this.dragStart = { x: e.clientX, y: e.clientY };
    this.tempIsFloating = this.isFloating; // 初始化临时状态

    const screen = this.shadowRoot?.querySelector(".screen") as HTMLDivElement | null;
    const dragHandle = this.shadowRoot?.querySelector(".drag-handle") as HTMLDivElement | null;
    if (screen && dragHandle) {
      // 拖拽过程中，暂时禁用 screen 内部所有元素的 pointer-events
      // 这样即使鼠标移动到 VNC 窗口内部，也不会被 canvas 捕获
      screen.classList.add("dragging");

      // 记录鼠标相对于拖拽句柄的位置（点 A）
      const dragHandleRect = dragHandle.getBoundingClientRect();
      this.dragAnchor = {
        x: e.clientX - dragHandleRect.left,
        y: e.clientY - dragHandleRect.top,
      };

      const rect = screen.getBoundingClientRect();
      // 获取 claw-computer-panel 本身的尺寸
      const hostRect = this.getBoundingClientRect();

      // 使用 offsetWidth/offsetHeight 获取实际尺寸
      const screenWidth = screen.offsetWidth;
      const screenHeight = screen.offsetHeight;
      const hostHeight = this.offsetHeight;

      this.initialRect = {
        x: this.isFloating ? this.floatingRect.x : rect.left,
        y: this.isFloating ? this.floatingRect.y : rect.top,
        width: screenWidth,
        height: screenHeight,
        offsetY: this.dockedOffsetY,
        offsetX: this.dockedOffsetX,
        containerHeight: hostHeight,
        containerTop: hostRect.top,
        containerLeft: hostRect.left,
        containerWidth: this.offsetWidth,
      };

      if (!this.isFloating) {
        this.floatingRect = {
          x: rect.left,
          y: rect.top,
          width: screenWidth,
          height: screenHeight,
        };

        // 打印尺寸信息，用于调试
        const canvas = this.shadowRoot?.querySelector(".screen canvas") as HTMLCanvasElement | null;
        if (canvas) {
          console.log("=== 切换到悬浮模式时的尺寸信息 ===");
          console.log("screen 宽度:", screenWidth);
          console.log("screen 高度:", screenHeight);
          console.log("screen 比例:", screenWidth / screenHeight);
          console.log("canvas 宽度:", canvas.clientWidth);
          console.log("canvas 高度:", canvas.clientHeight);
          console.log("canvas 比例:", canvas.clientWidth / canvas.clientHeight);
        }
      }
    }

    window.addEventListener("mousemove", this.handleDragMove, { capture: true, passive: false });
    window.addEventListener("mouseup", this.handleDragEnd, { capture: true });
  };

  private handleDragMove = (e: MouseEvent) => {
    if (!this.isDragging) {
      return;
    }

    // 安全检查：如果鼠标按钮不再按下，就停止拖拽
    if (e.buttons !== 1) {
      this.cleanupDragListeners();
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const dx = e.clientX - this.dragStart.x;
    const dy = e.clientY - this.dragStart.y;

    // 获取我们自己的左边界
    const hostRect = this.getBoundingClientRect();

    // 根据鼠标位置更新临时悬浮状态
    if (e.clientX < hostRect.left) {
      // 鼠标在左侧，临时切换到悬浮模式
      if (!this.tempIsFloating) {
        this.tempIsFloating = true;
        // 计算新的悬浮窗口位置，保持鼠标相对于拖拽句柄的位置（点 A）
        const newX = e.clientX - this.dragAnchor.x;
        const newY = e.clientY - this.dragAnchor.y;

        // 更新 floatingRect
        this.floatingRect = {
          x: newX,
          y: newY,
          width: this.initialRect.width,
          height: this.initialRect.height,
        };

        // 更新 initialRect，使其基于新的悬浮位置
        this.initialRect = {
          ...this.initialRect,
          x: newX,
          y: newY,
        };

        // 更新 dragStart，使其从当前位置继续拖拽
        this.dragStart = { x: e.clientX, y: e.clientY };
      }
    } else {
      // 鼠标在右侧，临时切换回停靠模式
      if (this.tempIsFloating) {
        this.tempIsFloating = false;
        // 重置停靠模式的偏移量
        this.dockedOffsetY = this.initialRect.offsetY;
        this.dockedOffsetX = 0;
        // 更新 dragStart，使其从当前位置继续拖拽
        this.dragStart = { x: e.clientX, y: e.clientY };
      }
    }

    if (this.tempIsFloating) {
      let newX = this.initialRect.x + dx;
      let newY = this.initialRect.y + dy;

      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;

      // 限制悬浮窗口不超出屏幕边界
      newX = Math.max(0, Math.min(newX, windowWidth - this.initialRect.width));
      newY = Math.max(0, Math.min(newY, windowHeight - this.initialRect.height));

      this.floatingRect = {
        x: newX,
        y: newY,
        width: this.initialRect.width,
        height: this.initialRect.height,
      };
    } else {
      // 如果没有超过分割线，继续停靠模式的拖拽
      // 每次都直接获取当前尺寸
      const hostHeight = this.offsetHeight;
      const screen = this.shadowRoot?.querySelector(".screen") as HTMLDivElement | null;
      const screenHeight = screen?.offsetHeight || 0;

      // 计算最高和最低不能超过多少
      // 当 screen 居中时，初始顶部位置是 (hostHeight - screenHeight) / 2
      const initialTop = (hostHeight - screenHeight) / 2;

      // 最高：screen 顶部 = host 顶部 → 偏移量 = 0 - initialTop = -initialTop
      const maxUpOffset = -initialTop;

      const maxDownOffset = hostHeight - screenHeight - initialTop;

      let newOffsetY = this.initialRect.offsetY + dy;

      // 使用计算出来的边界限制
      newOffsetY = Math.max(maxUpOffset, Math.min(newOffsetY, maxDownOffset));

      this.dockedOffsetY = newOffsetY;

      // 禁止左右移动
      this.dockedOffsetX = 0;
    }
  };

  private cleanupDragListeners = () => {
    this.isDragging = false;

    // 移除拖拽过程中添加的类，恢复 pointer-events
    const screen = this.shadowRoot?.querySelector(".screen") as HTMLDivElement | null;
    if (screen) {
      screen.classList.remove("dragging");
    }

    try {
      window.removeEventListener("mousemove", this.handleDragMove, { capture: true });
      window.removeEventListener("mouseup", this.handleDragEnd, { capture: true });
    } catch (e) {
      console.error("Error removing drag event listeners:", e);
    }
  };

  private handleDragEnd = (e: MouseEvent) => {
    // 根据松手位置决定是否永久切换到悬浮模式
    const hostRect = this.getBoundingClientRect();
    if (e.clientX < hostRect.left) {
      // 在左侧松手，永久切换到悬浮模式
      this.isFloating = true;
      // 触发事件告诉父组件关闭停靠面板
      this.dispatchEvent(new CustomEvent("float", { bubbles: true, composed: true }));
    } else {
      // 在右侧松手，保持停靠模式
      this.isFloating = false;
      this.dockedOffsetX = 0;
      // 触发事件告诉父组件展开停靠面板
      this.dispatchEvent(new CustomEvent("dock", { bubbles: true, composed: true }));
    }

    this.cleanupDragListeners();
  };

  private cleanupResizeListeners = () => {
    this.isResizing = false;
    try {
      window.removeEventListener("mousemove", this.handleResizeMove);
      window.removeEventListener("mouseup", this.handleResizeEnd);
    } catch (e) {
      console.error("Error removing resize event listeners:", e);
    }
  };

  private handleResizeStart = (e: MouseEvent, edge: string) => {
    e.preventDefault();
    e.stopPropagation();

    // 先清理旧的监听器，防止重复添加
    this.cleanupResizeListeners();

    this.isResizing = true;
    this.resizeEdge = edge;
    this.dragStart = { x: e.clientX, y: e.clientY };

    // 每次开始缩放时，获取最新的 canvas 比例
    const canvas = this.shadowRoot?.querySelector(".screen canvas") as HTMLCanvasElement | null;
    if (canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      this.canvasRatio = canvas.clientWidth / canvas.clientHeight;
    }

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

    // 安全检查：如果鼠标按钮不再按下，就停止调整大小
    if (e.buttons !== 1) {
      this.cleanupResizeListeners();
      return;
    }

    e.preventDefault();

    const dx = e.clientX - this.dragStart.x;
    const dy = e.clientY - this.dragStart.y;

    // 考虑到窗口有边框和标题栏，实际的 canvas 内容区域要减去这些 padding
    // 左右 padding: 5.4px * 2 = 10.8px
    // 上下 padding: 32.4px (标题栏) + 5.4px (底边) = 37.8px
    const PADDING_X = 10.8;
    const PADDING_Y = 37.8;

    let { x, y, width, height } = this.initialRect;

    // 1. 先计算出用户拖拽后的预期宽高
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

    // 2. 根据 canvas 的比例强制修正窗口尺寸，确保窗口能仅仅贴合 VNC
    let canvasW = width - PADDING_X;
    let canvasH = height - PADDING_Y;

    if (this.resizeEdge === "top" || this.resizeEdge === "bottom") {
      // 如果只拖拽上下边，以高度为基准计算宽度
      canvasW = canvasH * this.canvasRatio;
      width = canvasW + PADDING_X;
      if (this.resizeEdge.includes("left")) {
        x = this.initialRect.x + (this.initialRect.width - width);
      }
    } else {
      // 左右边或者对角线，统一以宽度为基准计算高度
      canvasH = canvasW / this.canvasRatio;
      height = canvasH + PADDING_Y;
      if (this.resizeEdge.includes("top")) {
        y = this.initialRect.y + (this.initialRect.height - height);
      }
    }

    // 3. 最小尺寸限制
    if (width < 200) {
      width = 200;
      canvasW = width - PADDING_X;
      canvasH = canvasW / this.canvasRatio;
      height = canvasH + PADDING_Y;
      if (this.resizeEdge.includes("left")) {
        x = this.initialRect.x + (this.initialRect.width - width);
      }
      if (this.resizeEdge.includes("top")) {
        y = this.initialRect.y + (this.initialRect.height - height);
      }
    }
    // 注意：这里不再单独限制 height，因为 height 已经和 width 绑定了

    this.floatingRect = { x, y, width, height };

    if (this.rfb) {
      requestAnimationFrame(() => this.rfb?.resize?.());
    }
  };

  private handleResizeEnd = () => {
    this.cleanupResizeListeners();
    setTimeout(() => this.rfb?.resize?.(), 50);
  };

  private connect = async () => {
    let url =
      this.vncUrl || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/vnc`;

    if (this.vncTarget) {
      try {
        const urlObj = new URL(url);
        urlObj.searchParams.set("target", this.vncTarget);
        url = urlObj.toString();
      } catch {
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
    let screen = this.screenRef.value;

    if (!screen) {
      screen = this.shadowRoot?.querySelector(".screen") as HTMLDivElement;
    }

    if (!screen) {
      console.error("Screen element not found");
      this.status = "初始化失败：找不到屏幕元素";
      return;
    }

    const existingCanvases = screen.querySelectorAll("canvas");
    existingCanvases.forEach((canvas) => canvas.remove());

    try {
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

      this.rfb.addEventListener("securityfailure", (e: unknown) => {
        const event = e as CustomEvent;
        console.error("VNC security failure:", event.detail);
        this.status = `Security negotiation failed: ${event.detail.reason || "Unknown reason"}`;
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

  private handleWindowBlur = () => {
    this.cleanupDragListeners();
    this.cleanupResizeListeners();
  };

  firstUpdated() {
    window.addEventListener("resize", this.handleResize);
    window.addEventListener("blur", this.handleWindowBlur);

    if (this.enabled && this.vncUrl) {
      setTimeout(() => {
        void this.connect();
      }, 100);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("resize", this.handleResize);
    window.removeEventListener("blur", this.handleWindowBlur);
    this.cleanupDragListeners();
    this.cleanupResizeListeners();
    this.disconnect();
  }
}
