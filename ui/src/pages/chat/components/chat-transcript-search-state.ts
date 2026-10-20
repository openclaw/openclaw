export class TranscriptSearchState {
  private value = { open: false, query: "" };
  private listeners = new Set<() => void>();
  private focusPending = false;
  private returnFocusTarget: HTMLElement | null = null;
  private restoreFocus: (() => void) | undefined;

  get snapshot(): Readonly<{ open: boolean; query: string }> {
    return this.value;
  }

  subscribe(notify: () => void): () => void {
    this.listeners.add(notify);
    return () => this.listeners.delete(notify);
  }

  reset(): void {
    this.focusPending = false;
    this.returnFocusTarget = null;
    this.restoreFocus = undefined;
    this.publish(false, "");
  }

  toggle(event?: Event, restoreFocus?: () => void): void {
    if (this.value.open) {
      this.close();
      return;
    }
    const connected = (target: EventTarget | null | undefined) =>
      target instanceof HTMLElement && target.isConnected ? target : null;
    this.returnFocusTarget = connected(event?.target);
    this.restoreFocus = restoreFocus;
    this.focusPending = true;
    this.publish(true, "");
  }

  close(): void {
    const target = this.returnFocusTarget;
    const restoreFocus = this.restoreFocus;
    this.reset();
    queueMicrotask(() => {
      if (target?.isConnected) {
        target.focus({ preventScroll: true });
      } else {
        restoreFocus?.();
      }
    });
  }

  setQuery(query: string): void {
    this.publish(this.value.open, query);
  }

  focusInput(element: HTMLInputElement): void {
    if (!this.focusPending) {
      return;
    }
    this.focusPending = false;
    queueMicrotask(() => {
      if (element.isConnected) {
        element.focus({ preventScroll: true });
      }
    });
  }

  private publish(open: boolean, query: string): void {
    if (this.value.open === open && this.value.query === query) {
      return;
    }
    this.value = { open, query };
    for (const notify of this.listeners) {
      notify();
    }
  }
}
