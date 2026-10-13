import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import type { DebugOverlayLayout } from "./debug-overlay-layout.runtime.ts";

type Mode = "expanded" | "minimized";

class DebugOverlayLayoutDirective extends AsyncDirective {
  private element?: HTMLElement;
  private mode: Mode = "expanded";
  private layout?: DebugOverlayLayout;
  private loading = false;

  render(_mode: Mode) {
    return nothing;
  }

  override update(part: ElementPart, [mode]: [Mode]) {
    this.element = part.element instanceof HTMLElement ? part.element : undefined;
    this.mode = mode;
    if (this.layout) {
      this.layout.update(mode);
    } else {
      this.load();
    }
    return nothing;
  }

  private load(): void {
    if (this.loading || !this.isConnected) {
      return;
    }
    this.loading = true;
    // The frame is part of startup chrome; its interaction machinery is only
    // needed once the panel opens. Late imports must never revive a closed frame.
    void import("./debug-overlay-layout.runtime.ts")
      .then(({ DebugOverlayLayout }) => {
        this.loading = false;
        if (!this.isConnected || !this.element?.isConnected) {
          return;
        }
        this.layout = new DebugOverlayLayout(this.element);
        this.layout.update(this.mode);
      })
      .catch((error: unknown) => {
        this.loading = false;
        // Vite's preload error also reaches the app's stale-chunk recovery listener.
        console.error("System busyness position controls could not load. Reload to retry.", error);
      });
  }

  protected override disconnected(): void {
    this.layout?.disconnect();
  }
  protected override reconnected(): void {
    if (this.layout) {
      this.layout.reconnect();
    } else {
      this.load();
    }
  }
}

export const debugOverlayLayout = directive(DebugOverlayLayoutDirective);
