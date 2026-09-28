import { resolveSidebarSessionsScrollState } from "./app-sidebar-session-types.ts";
import type { SidebarSessionsScrollState } from "./app-sidebar-session-types.ts";

/** Owns sidebar scroll observation and its paint-coalesced reactive state. */
export class SessionDataScrollController {
  state: SidebarSessionsScrollState = "none";

  private element: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private frame: number | null = null;

  constructor(private readonly notify: () => void) {}

  synchronize(host: Pick<HTMLElement, "querySelector">): void {
    const element = host.querySelector<HTMLElement>(".sidebar-shell__body");
    if (element !== this.element) {
      this.resizeObserver?.disconnect();
      this.element = element;
      this.resizeObserver = null;
      if (element && typeof ResizeObserver === "function") {
        this.resizeObserver = new ResizeObserver(() => this.update(element));
        this.resizeObserver.observe(element);
      }
    }
    if (element && this.frame === null) {
      // One rAF-coalesced read rides paint layout instead of flushing every update.
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        if (this.element?.isConnected) {
          this.update(this.element);
        }
      });
    }
  }

  update(element: HTMLElement): void {
    const nextState = resolveSidebarSessionsScrollState(element);
    if (nextState !== this.state) {
      this.state = nextState;
      this.notify();
    }
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.element = null;
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }
}
