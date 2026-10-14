import { solidContent } from "../../../lit/solid-content.tsx";
import {
  ChatContextWindowControl,
  type ChatContextWindowControlParams,
} from "./chat-context-window-control.tsx";

export type { ChatContextWindowControlParams } from "./chat-context-window-control.tsx";

export function renderContextWindowControl(
  contextWindow: ChatContextWindowControlParams,
  sessionKey: string,
) {
  return solidContent(ChatContextWindowControl, { contextWindow, sessionKey });
}
