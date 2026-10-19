type Confirmation = {
  frame: HTMLIFrameElement;
  title: string;
  text: string;
  kind: "message" | "file";
  isCurrent: () => boolean;
};

/** One synchronous admission owner for pending App decisions. */
export function createMcpAppConfirm() {
  let pending: (Confirmation & { resolve: (accepted: boolean) => void }) | null = null;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((notify) => notify());
  function finish(accepted: boolean, restoreFocus = true): void {
    const decision = pending;
    if (!decision) {
      return;
    }
    pending = null;
    publish();
    const current = decision.isCurrent() && decision.frame.isConnected;
    if (restoreFocus && current) {
      decision.frame.focus({ preventScroll: true });
    }
    decision.resolve(accepted && current);
  }
  return {
    read: () => pending,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    request(confirmation: Confirmation): Promise<boolean> {
      if (pending || !confirmation.isCurrent()) {
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve) => {
        pending = { ...confirmation, resolve };
        publish();
      });
    },
    cancel: () => finish(false, false),
    update() {
      if (pending && !pending.isCurrent()) {
        finish(false, false);
      }
    },
    finish,
  };
}
export type McpAppConfirm = ReturnType<typeof createMcpAppConfirm>;
