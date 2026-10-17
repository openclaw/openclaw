import { chatRunPresentation, type ChatRunPublication } from "./chat-run-presentation.ts";

export function cancelChatStreamRenderFrame(state: object): void {
  chatRunPresentation(state).cancelFrame();
}

export function requestChatPageUpdate(
  state: { requestUpdate?: () => void },
  mode: "immediate" | "animation-frame" = "immediate",
): void {
  chatRunPresentation(state).requestViewUpdate(() => state.requestUpdate?.(), mode);
}

export function publishChatRunState(state: object, mode: ChatRunPublication = "immediate"): void {
  chatRunPresentation(state).publish(mode);
}

export function mutateChatRunState<T>(
  state: object,
  operation: () => T,
  mode?: ChatRunPublication | false,
): T {
  return chatRunPresentation(state).batch(operation, mode);
}
