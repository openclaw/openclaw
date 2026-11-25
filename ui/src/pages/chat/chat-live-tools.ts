/** History replay needs the tool reducer without the live dispatcher's pane imports. */
export function loadChatLiveTools() {
  return import("./tool-stream.ts");
}
