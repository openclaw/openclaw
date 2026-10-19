type WebView2Bridge = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
};

export type NativeChatDrafts = {
  subscribe: (listener: (draft: string) => void) => () => void;
  dispose: () => void;
};

function readNativeDraft(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || !("type" in raw) || raw.type !== "draft-text") {
    return null;
  }
  const payload = "payload" in raw ? raw.payload : null;
  const text = payload && typeof payload === "object" && "text" in payload ? payload.text : null;
  return typeof text === "string" ? text : null;
}

/**
 * WebView2's message-only bridge is not a DOM EventTarget. Subscribe before
 * the ready handshake and pair its native subscription with disposal below.
 * Drafts received while Chat is not mounted are retained for its next subscriber.
 */
export function createNativeChatDrafts(): NativeChatDrafts {
  const bridge = (window as Window & { chrome?: { webview?: WebView2Bridge } }).chrome?.webview;
  if (!bridge) {
    return {
      subscribe: () => () => {},
      dispose: () => {},
    };
  }

  let pendingDraft: string | null = null;
  const listeners = new Set<(draft: string) => void>();
  const handler = (event: MessageEvent) => {
    const draft = readNativeDraft(event.data);
    if (draft === null) {
      return;
    }
    if (listeners.size === 0) {
      pendingDraft = draft;
      return;
    }
    for (const listener of listeners) {
      listener(draft);
    }
  };

  bridge.addEventListener("message", handler);
  // WebView2's one-argument host API is distinct from Window.postMessage.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  bridge.postMessage({ type: "ready" });

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (pendingDraft !== null) {
        const draft = pendingDraft;
        pendingDraft = null;
        listener(draft);
      }
      return () => listeners.delete(listener);
    },
    dispose() {
      listeners.clear();
      pendingDraft = null;
      bridge.removeEventListener("message", handler);
    },
  };
}
