import type { ReactiveController, ReactiveControllerHost } from "lit";

const INDICATORS = ".session-glyph__ring, .session-glyph__trace-run";
const PAUSED_CLASS = "session-run-indicator--offscreen";

/** One scroll-root observer owns activity animation visibility for the sidebar. */
export class SidebarSessionVisibility implements ReactiveController {
  private observer: IntersectionObserver | null = null;
  private readonly rows = new Map<Element, boolean>();

  constructor(private readonly host: ReactiveControllerHost & HTMLElement) {
    host.addController(this);
  }

  hostConnected(): void {
    this.host.requestUpdate();
  }

  hostUpdated(): void {
    if (!this.host.isConnected) {
      return;
    }
    const root = this.host.querySelector(".sidebar-shell__body");
    if (this.observer?.root !== root) {
      this.hostDisconnected();
    }
    if (!root) {
      return;
    }
    this.observer ??= new IntersectionObserver(
      (entries, observer) => {
        if (observer !== this.observer) {
          return;
        }
        for (const entry of entries) {
          if (this.rows.has(entry.target)) {
            // Edge contact already intersects at threshold zero; entering further may not notify.
            const visible = entry.isIntersecting;
            this.rows.set(entry.target, visible);
            this.setPaused(entry.target, !visible);
          }
        }
      },
      { root },
    );
    const rows = new Set(
      [...root.querySelectorAll(INDICATORS)]
        .map((indicator) => indicator.closest(".session-row-host"))
        .filter((row): row is Element => row !== null),
    );
    for (const row of this.rows.keys()) {
      if (!rows.has(row)) {
        this.observer.unobserve(row);
        this.rows.delete(row);
        this.setPaused(row, false);
      }
    }
    for (const row of rows) {
      if (!this.rows.has(row)) {
        this.rows.set(row, false);
        this.observer.observe(row);
      }
      // Lit can replace the ring or its queued class without moving the row.
      this.setPaused(row, !this.rows.get(row));
    }
  }

  hostDisconnected(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const row of this.rows.keys()) {
      this.setPaused(row, false);
    }
    this.rows.clear();
  }

  private setPaused(row: Element, paused: boolean): void {
    for (const indicator of row.querySelectorAll(INDICATORS)) {
      indicator.classList.toggle(PAUSED_CLASS, paused);
    }
  }
}
