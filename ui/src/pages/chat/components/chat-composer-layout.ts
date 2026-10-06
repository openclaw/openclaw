import { noChange, type ElementPart, type Part } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { t } from "../../../i18n/index.ts";
import { scheduleTextareaHeightAdjustment } from "./chat-composer-dom.ts";

type ComposerLayoutOptions = {
  width?: string | null;
  onWidthChange?: (value: string | undefined) => void;
};

// One lifecycle for both surfaces. No input listener, draft clone, or height
// preference: native field-sizing owns edits; only settled geometry is read.
class ComposerLayoutDirective extends AsyncDirective {
  private element: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private edge: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private events: AbortController | null = null;
  private cancelDrag: (() => void) | null = null;
  private options: ComposerLayoutOptions = {};
  private baseline: string | undefined;
  private lastWidth: string | undefined;
  private ownWidth: string | undefined;
  private pendingWidth = false;
  private initialized = false;
  private minimumWidth = 480;
  private refreshMinimum = true;
  private contextObserver: MutationObserver | null = null;
  private measurementFrame: number | null = null;

  override render(_options: ComposerLayoutOptions) {
    return noChange;
  }

  override update(part: Part, [options]: [ComposerLayoutOptions]) {
    const width = options.width ?? undefined;
    const acknowledgesCommit = this.pendingWidth && width === this.ownWidth;
    if (!this.initialized || (width !== this.lastWidth && !acknowledgesCommit)) {
      this.baseline = width;
      this.refreshMinimum = true;
      this.initialized = true;
    }
    if (acknowledgesCommit || width !== this.lastWidth) {
      this.pendingWidth = false;
    }
    this.lastWidth = width;
    this.options = options;
    this.element = (part as ElementPart).element as HTMLElement;
    // Element directives run before their children/ancestors are attached.
    queueMicrotask(() => {
      if (this.isConnected && this.element?.isConnected) {
        this.attach();
      }
    });
    return noChange;
  }

  private attach() {
    const input = this.element!;
    if (this.events) {
      return;
    }
    this.root = input.closest<HTMLElement>(".chat, .new-session-page") ?? input.parentElement;
    const root = this.root;
    const editor = input.querySelector<HTMLTextAreaElement>(
      ".agent-chat__composer-combobox > textarea",
    );
    if (!root || !editor) {
      return;
    }
    this.events = new AbortController();
    const shell = input.closest<HTMLElement>(".agent-chat__composer-shell")!;
    const context = shell.querySelector<HTMLElement>(".chat-footer__context");
    const edge = document.createElement("div");
    edge.className = "agent-chat__composer-width-edge";
    edge.setAttribute("role", "separator");
    edge.setAttribute("aria-orientation", "vertical");
    edge.setAttribute("aria-label", t("common.resizeMessageWidth"));
    edge.tabIndex = 0;
    input.append(edge);
    this.edge = edge;
    const measure = () => {
      if (!input.isConnected) {
        return;
      }
      const footer = input.closest<HTMLElement>(".chat-footer");
      const shellStyle = getComputedStyle(shell);
      const margins =
        Number.parseFloat(shellStyle.marginTop) + Number.parseFloat(shellStyle.marginBottom);
      const contextHeight = context?.scrollHeight ?? 0;
      const contextGap = contextHeight > 0 ? Number.parseFloat(shellStyle.rowGap) || 0 : 0;
      // Measure flow chrome explicitly: a capped scrollport can omit its
      // margins and a flex-shrunk context hides its natural content height.
      const chrome =
        Math.max(0, input.offsetHeight - editor.offsetHeight) +
        (footer ? margins + contextHeight + contextGap : 0);
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const scroll = shell.closest<HTMLElement>(".new-session-page__scroll");
      const budget = footer
        ? Number.parseFloat(getComputedStyle(footer).maxHeight)
        : Math.min(
            viewportHeight * 0.8,
            viewportHeight - shell.getBoundingClientRect().top - (scroll?.scrollTop ?? 0) - margins,
          );
      if (Number.isFinite(budget)) {
        const viewportLimit = (window.visualViewport?.height ?? window.innerHeight) * 0.8;
        const limit = `${Math.max(36, Math.min(viewportLimit, budget - chrome))}px`;
        if (input.style.getPropertyValue("--chat-composer-editor-height-limit") !== limit) {
          input.style.setProperty("--chat-composer-editor-height-limit", limit);
          scheduleTextareaHeightAdjustment(editor);
        }
      }
      const renderedWidth = Math.round(shell.getBoundingClientRect().width);
      if (this.refreshMinimum && this.availableWidth() >= 480) {
        this.minimumWidth = Math.min(480, renderedWidth);
        this.refreshMinimum = false;
      }
      edge.setAttribute("aria-valuenow", String(renderedWidth));
      edge.setAttribute(
        "aria-valuemin",
        String(Math.min(this.minimumWidth, this.availableWidth(), renderedWidth)),
      );
      edge.setAttribute("aria-valuemax", String(Math.round(this.availableWidth())));
    };
    const scheduleMeasure = () => {
      if (this.measurementFrame !== null) {
        return;
      }
      this.measurementFrame = requestAnimationFrame(() => {
        this.measurementFrame = null;
        if (this.events && input.isConnected) {
          measure();
        }
      });
    };
    if (typeof ResizeObserver === "function") {
      this.observer = new ResizeObserver(scheduleMeasure);
      for (const node of new Set([
        root,
        input,
        editor,
        context,
        input.closest(".chat-footer"),
        shell.parentElement,
        shell.closest(".agent-chat__welcome"),
      ])) {
        if (node) {
          this.observer.observe(node);
        }
      }
    }
    if (context && typeof MutationObserver === "function") {
      this.contextObserver = new MutationObserver(scheduleMeasure);
      this.contextObserver.observe(context, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    }
    const eventOptions = { signal: this.events.signal };
    window.addEventListener("resize", scheduleMeasure, eventOptions);
    window.visualViewport?.addEventListener("resize", scheduleMeasure, eventOptions);
    edge.addEventListener("pointerdown", (event) => this.startDrag(event), eventOptions);
    edge.addEventListener(
      "dblclick",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.cancelDrag?.();
        this.commit(this.baseline);
      },
      eventOptions,
    );
    edge.addEventListener(
      "keydown",
      (event) => {
        if (event.ctrlKey || event.altKey || event.metaKey || this.cancelDrag) {
          return;
        }
        if (event.key === "Enter" || event.key === "Home") {
          event.preventDefault();
          this.commit(this.baseline);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const current = shell.getBoundingClientRect().width;
          const width = this.clampWidth(current + (event.key === "ArrowLeft" ? 20 : -20));
          if (Math.abs(width - current) >= 1) {
            this.commit(`${width}px`);
          }
        }
      },
      eventOptions,
    );
    measure();
  }

  private availableWidth() {
    const shell = this.element!.closest<HTMLElement>(".agent-chat__composer-shell")!;
    const region = shell.parentElement!;
    const style = getComputedStyle(region);
    const inset =
      Number.parseFloat(getComputedStyle(shell).getPropertyValue("--chat-composer-side-inset")) ||
      36;
    return Math.max(
      0,
      region.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight) -
        inset,
    );
  }

  private clampWidth(value: number) {
    const available = this.availableWidth();
    return Math.round(Math.max(Math.min(this.minimumWidth, available), Math.min(available, value)));
  }

  private commit(value: string | undefined) {
    this.ownWidth = value;
    this.pendingWidth = true;
    this.options.onWidthChange?.(value);
  }

  private startDrag(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary || this.cancelDrag || !this.options.onWidthChange) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const edge = this.edge!,
      root = this.root!;
    const start = this.element!.getBoundingClientRect().width;
    const origin = event.clientX;
    let width = start;
    let moved = false;
    const events = new AbortController();
    const finish = (save: boolean) => {
      events.abort();
      this.cancelDrag = null;
      root.style.removeProperty("--chat-thread-drag-width");
      edge.classList.remove("agent-chat__composer-width-edge--dragging");
      if (edge.hasPointerCapture(event.pointerId)) {
        edge.releasePointerCapture(event.pointerId);
      }
      if (save && moved && Math.abs(width - start) >= 3) {
        this.commit(`${width}px`);
      }
    };
    this.cancelDrag = () => finish(false);
    edge.setPointerCapture(event.pointerId);
    edge.classList.add("agent-chat__composer-width-edge--dragging");
    const options = { signal: events.signal };
    edge.addEventListener(
      "pointermove",
      (next) => {
        if (next.pointerId !== event.pointerId) {
          return;
        }
        const delta = next.clientX - origin;
        if (!moved && Math.abs(delta) < 3) {
          return;
        }
        moved = true;
        width = this.clampWidth(start - 2 * delta);
        root.style.setProperty("--chat-thread-drag-width", `${width}px`);
      },
      options,
    );
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
      edge.addEventListener(
        type,
        (next) => {
          if (next.pointerId === event.pointerId) {
            finish(type === "pointerup");
          }
        },
        options,
      );
    }
  }

  protected override disconnected() {
    this.cancelDrag?.();
    this.events?.abort();
    this.events = null;
    this.observer?.disconnect();
    this.observer = null;
    this.contextObserver?.disconnect();
    this.contextObserver = null;
    if (this.measurementFrame !== null) {
      cancelAnimationFrame(this.measurementFrame);
    }
    this.measurementFrame = null;
    this.edge?.remove();
    this.edge = null;
    this.element?.style.removeProperty("--chat-composer-editor-height-limit");
  }

  protected override reconnected() {
    queueMicrotask(() => {
      if (this.isConnected && this.element?.isConnected) {
        this.attach();
      }
    });
  }
}

export const composerLayout = directive(ComposerLayoutDirective);
