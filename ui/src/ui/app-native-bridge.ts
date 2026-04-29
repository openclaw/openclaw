type WebView2Bridge = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
};

export type NativeBridgeMessage =
  | { type: "draft-text"; payload: { text: string } }
  | { type: "ready"; payload?: Record<string, unknown> };

export type NativeBridgeHost = {
  handleChatDraftChange: (next: string) => void;
};

function getWebview(): WebView2Bridge | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webview = (window as any).chrome?.webview;
  return webview as WebView2Bridge | undefined;
}

export function isWebView2(): boolean {
  return getWebview() !== undefined;
}

export function sendToNative(msg: NativeBridgeMessage): void {
  getWebview()?.postMessage(msg);
}

function handleNativeMessage(host: NativeBridgeHost, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== "string") return;
  if (msg.type === "draft-text") {
    const text =
      msg.payload && typeof msg.payload === "object"
        ? (msg.payload as Record<string, unknown>).text
        : undefined;
    if (typeof text === "string") host.handleChatDraftChange(text);
  }
}

/**
 * Subscribes to WebView2 native messages and sends the ready handshake.
 * addEventListener is called BEFORE the ready handshake so no messages
 * are missed between the handshake and the first listen.
 * Returns a cleanup function that removes the listener.
 * No-op (returns empty cleanup) when not running inside WebView2.
 */
export function initNativeBridge(host: NativeBridgeHost): () => void {
  const bridge = getWebview();
  if (!bridge) return () => {};

  const handler = (event: MessageEvent) => {
    handleNativeMessage(host, event.data);
  };

  // Register listener FIRST, then send ready — order matters.
  bridge.addEventListener("message", handler);
  sendToNative({ type: "ready" });

  return () => {
    bridge.removeEventListener("message", handler);
  };
}
