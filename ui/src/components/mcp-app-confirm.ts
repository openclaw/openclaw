type Confirmation = {
  frame: HTMLIFrameElement;
  title: string;
  text: string;
  kind: "message" | "file";
  isCurrent: () => boolean;
};

/** One pending decision shared by all App requests in the owning pane. */
export class McpAppConfirm {
  private pending: (Confirmation & { resolve: (accepted: boolean) => void }) | null = null;

  constructor(private readonly requestUpdate: () => void) {}

  request(confirmation: Confirmation): Promise<boolean> {
    if (this.pending || !confirmation.isCurrent()) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      this.pending = { ...confirmation, resolve };
      this.requestUpdate();
    });
  }

  cancel(): void {
    this.finish(false, false);
  }

  update(): void {
    if (this.pending && !this.pending.isCurrent()) {
      this.cancel();
    }
  }

  readonly focusStrip = (element: Element | undefined): void => {
    const pending = this.pending;
    // The renderer assigns the ref before inserting the strip into the document.
    queueMicrotask(() => {
      if (element instanceof HTMLElement && element.isConnected && this.pending === pending) {
        element.focus({ preventScroll: true });
      }
    });
  };

  finish(accepted: boolean, restoreFocus = true): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.pending = null;
    this.requestUpdate();
    const current = pending.isCurrent() && pending.frame.isConnected;
    if (restoreFocus && current) {
      pending.frame.focus({ preventScroll: true });
    }
    pending.resolve(accepted && current);
  }

  get current() {
    return this.pending;
  }
}
