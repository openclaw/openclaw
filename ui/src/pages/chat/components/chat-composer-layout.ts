import { t } from "../../../i18n/index.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import type { createPointerDrag } from "../../../lib/reactive/pointer-drag.ts";
import { scheduleTextareaHeightAdjustment } from "./chat-composer-dom.ts";

export type ComposerLayoutOptions = {
  getEditor: () => HTMLTextAreaElement | null;
  getContext?: () => HTMLElement | undefined;
  width?: string | null;
  onWidthChange?: (value: string | undefined) => void;
};

// One lifecycle for both surfaces. No input listener, draft clone, or height
// preference: native field-sizing owns edits; only settled geometry is read.
export class ComposerLayout {
  private element: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private edge: HTMLElement | null = null;
  private events: AbortController | null = null;
  private cancelDrag: (() => void) | null = null;
  private options: ComposerLayoutOptions = { getEditor: () => null };
  private baseline: string | undefined;
  private lastWidth: string | undefined;
  private ownWidth: string | undefined;
  private pendingWidth = false;
  private initialized = false;
  private minimumWidth = 480;
  private refreshMinimum = true;
  private measurementFrame: number | null = null;
  private active = false;
  private measure: (() => void) | null = null;

  constructor(private readonly drag: ReturnType<typeof createPointerDrag>) {}

  update(element: HTMLElement, options: ComposerLayoutOptions) {
    if (this.events && this.element !== element) {
      this.disconnect();
    }
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
    this.element = element;
    this.active = true;
    // Hosts bind before their children/ancestors are attached.
    queueMicrotask(() => {
      if (this.active && this.element?.isConnected) {
        this.attach();
      }
    });
  }

  private attach() {
    const input = this.element!;
    if (this.events) {
      this.measure?.();
      return;
    }
    this.root = input.closest<HTMLElement>(".chat, .new-session-page") ?? input.parentElement;
    const root = this.root;
    const findEditor = () => this.options.getEditor();
    const mounted = findEditor();
    if (!root || !mounted) {
      return;
    }
    let editor = mounted;
    this.events = new AbortController();
    const shell = input.closest<HTMLElement>(".agent-chat__composer-shell")!;
    const context = this.options.getContext?.();
    const edge = document.createElement("div");
    edge.className = "agent-chat__composer-width-edge";
    edge.setAttribute("role", "separator");
    edge.setAttribute("aria-orientation", "vertical");
    edge.setAttribute("aria-label", t("common.resizeMessageWidth"));
    edge.tabIndex = 0;
    // Keep the border target outside landscape's scroll-clipped input.
    shell.append(edge);
    this.edge = edge;
    const measure = () => {
      const current = findEditor();
      if (!input.isConnected || !current) {
        return;
      }
      if (current !== editor) {
        // A new draft scope mounts a new textarea inside the same surface.
        editor = current;
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
      const paneBottom = Math.min(
        viewportHeight,
        scroll?.getBoundingClientRect().bottom ?? viewportHeight,
      );
      const budget = footer
        ? Number.parseFloat(getComputedStyle(footer).maxHeight)
        : Math.min(
            viewportHeight * 0.8,
            paneBottom - shell.getBoundingClientRect().top - (scroll?.scrollTop ?? 0) - margins,
          );
      if (Number.isFinite(budget)) {
        const viewportLimit = (window.visualViewport?.height ?? window.innerHeight) * 0.8;
        const limit = `${Math.max(36, Math.min(viewportLimit, budget - chrome))}px`;
        if (input.style.getPropertyValue("--chat-composer-editor-height-limit") !== limit) {
          input.style.setProperty("--chat-composer-editor-height-limit", limit);
          scheduleTextareaHeightAdjustment(editor);
        }
      }
      const inputBox = input.getBoundingClientRect();
      const shellBox = shell.getBoundingClientRect();
      edge.style.top = `${inputBox.top - shellBox.top + 18}px`;
      edge.style.bottom = `${Math.max(0, shellBox.bottom - inputBox.bottom) + 18}px`;
      const renderedWidth = Math.round(shellBox.width);
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
    this.measure = measure;
    const eventOptions = { signal: this.events.signal };
    listen(window, "resize", scheduleMeasure, eventOptions);
    if (window.visualViewport) {
      listen(window.visualViewport, "resize", scheduleMeasure, eventOptions);
    }
    listen(edge, "pointerdown", (event) => this.startDrag(event), eventOptions);
    listen(
      edge,
      "dblclick",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.cancelDrag?.();
        this.commit(this.baseline);
      },
      eventOptions,
    );
    listen(
      edge,
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

  targets(): Element[] {
    const input = this.element;
    const shell = input?.closest<HTMLElement>(".agent-chat__composer-shell");
    return [
      this.root,
      input,
      this.options.getEditor(),
      this.options.getContext?.(),
      input?.closest(".chat-footer"),
      shell && this.region(shell),
      shell?.closest(".agent-chat__welcome"),
      shell?.closest(".new-session-page__scroll"),
    ].filter((node): node is HTMLElement => Boolean(node));
  }

  // A Solid mount wraps the shell in a boxless `display: contents` host.
  private region(shell: HTMLElement) {
    let region = shell.parentElement!;
    while (region.parentElement && getComputedStyle(region).display === "contents") {
      region = region.parentElement;
    }
    return region;
  }

  private availableWidth() {
    const shell = this.element!.closest<HTMLElement>(".agent-chat__composer-shell")!;
    const region = this.region(shell);
    const style = getComputedStyle(region);
    // CSS owns the responsive gutter; use the same per-side token as its width rule.
    const inset = Number.parseFloat(
      getComputedStyle(shell).getPropertyValue("--chat-composer-inline-inset"),
    );
    return Math.max(
      0,
      region.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight) -
        2 * inset,
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
    const start = edge
      .closest<HTMLElement>(".agent-chat__composer-shell")!
      .getBoundingClientRect().width;
    const origin = event.clientX;
    let width = start;
    let moved = false;
    const finish = (save: boolean) => {
      this.cancelDrag = null;
      root.style.removeProperty("--chat-thread-drag-width");
      edge.classList.remove("agent-chat__composer-width-edge--dragging");
      if (save && moved && Math.abs(width - start) >= 3) {
        this.commit(`${width}px`);
      }
    };
    if (
      !this.drag.start(event, edge, {
        move: (next) => {
          const delta = next.clientX - origin;
          if (!moved && Math.abs(delta) < 3) {
            return;
          }
          moved = true;
          width = this.clampWidth(start - 2 * delta);
          root.style.setProperty("--chat-thread-drag-width", `${width}px`);
        },
        end: () => finish(true),
        cancel: () => finish(false),
      })
    ) {
      return;
    }
    this.cancelDrag = this.drag.cancel;
    edge.classList.add("agent-chat__composer-width-edge--dragging");
  }

  disconnect() {
    this.active = false;
    // The next attachment is a new opening with its own reset width.
    this.initialized = false;
    this.pendingWidth = false;
    this.cancelDrag?.();
    this.events?.abort();
    this.events = null;
    this.measure = null;
    if (this.measurementFrame !== null) {
      cancelAnimationFrame(this.measurementFrame);
    }
    this.measurementFrame = null;
    this.edge?.remove();
    this.edge = null;
    this.element?.style.removeProperty("--chat-composer-editor-height-limit");
  }
}
