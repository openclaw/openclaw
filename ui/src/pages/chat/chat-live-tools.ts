/** History replay and active-run recovery share one cold owner without live pane imports. */
export function loadChatLiveTools() {
  return import("./chat-history-inflight.runtime.ts");
}
