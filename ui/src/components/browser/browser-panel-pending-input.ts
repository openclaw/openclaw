/** Owns cancellable refreshes and input that must not outlive its browser document. */
export class BrowserPanelPendingInput {
  private refreshTimer: number | null = null;
  private wheelTimer: number | null = null;
  private inspectTimer: number | null = null;
  private wheelDeltaX = 0;
  private wheelDeltaY = 0;
  private lastInspectAt = 0;

  clear(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.clearInput();
  }

  clearInput(): void {
    if (this.wheelTimer !== null) {
      clearTimeout(this.wheelTimer);
      this.wheelTimer = null;
    }
    if (this.inspectTimer !== null) {
      clearTimeout(this.inspectTimer);
      this.inspectTimer = null;
    }
    this.wheelDeltaX = 0;
    this.wheelDeltaY = 0;
    this.lastInspectAt = 0;
  }

  scheduleRefresh(delayMs: number, refresh: () => void, ready: () => boolean = () => true): void {
    if (this.refreshTimer !== null) {
      // Keep the first deadline: sustained typing or scrolling must not starve feedback.
      return;
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      if (ready()) {
        refresh();
      } else {
        // Preserve trailing feedback without replacing a capture that is still in flight.
        this.scheduleRefresh(delayMs, refresh, ready);
      }
    }, delayMs);
  }

  queueWheel(
    deltaX: number,
    deltaY: number,
    delayMs: number,
    flush: (deltaX: number, deltaY: number) => void,
  ): void {
    this.wheelDeltaX += deltaX;
    this.wheelDeltaY += deltaY;
    if (this.wheelTimer !== null) {
      return;
    }
    this.wheelTimer = window.setTimeout(() => {
      this.wheelTimer = null;
      const pendingDeltaX = this.wheelDeltaX;
      const pendingDeltaY = this.wheelDeltaY;
      this.wheelDeltaX = 0;
      this.wheelDeltaY = 0;
      if (pendingDeltaX !== 0 || pendingDeltaY !== 0) {
        flush(pendingDeltaX, pendingDeltaY);
      }
    }, delayMs);
  }

  queueInspection(delayMs: number, current: () => boolean, inspect: () => void): void {
    const run = () => {
      if (!current()) {
        return;
      }
      this.lastInspectAt = Date.now();
      inspect();
    };
    if (Date.now() - this.lastInspectAt >= delayMs) {
      run();
      return;
    }
    if (this.inspectTimer !== null) {
      clearTimeout(this.inspectTimer);
    }
    this.inspectTimer = window.setTimeout(() => {
      this.inspectTimer = null;
      run();
    }, delayMs);
  }
}
