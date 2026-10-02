/** Owns cancellable refreshes and input that must not outlive its browser document. */
export class BrowserPanelPendingInput {
  private refreshTimer: number | undefined;
  private wheelTimer: number | undefined;
  private inspectTimer: number | undefined;
  private wheelDeltaX = 0;
  private wheelDeltaY = 0;
  private lastInspectAt = 0;

  clear(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.clearInput();
  }

  clearInput(): void {
    clearTimeout(this.wheelTimer);
    clearTimeout(this.inspectTimer);
    this.wheelTimer = undefined;
    this.inspectTimer = undefined;
    this.wheelDeltaX = 0;
    this.wheelDeltaY = 0;
    this.lastInspectAt = 0;
  }

  scheduleRefresh(delayMs: number, refresh: () => void): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      refresh();
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
    if (this.wheelTimer !== undefined) {
      return;
    }
    this.wheelTimer = window.setTimeout(() => {
      this.wheelTimer = undefined;
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
    clearTimeout(this.inspectTimer);
    this.inspectTimer = window.setTimeout(() => {
      this.inspectTimer = undefined;
      run();
    }, delayMs);
  }
}
