import type { ApplicationContext } from "../../app/context-types.ts";
import { solidContent } from "../../lit/solid-content.tsx";
import { ChatView, type ChatProps } from "./chat-view.tsx";

export function renderChat(props: ChatProps, application?: ApplicationContext) {
  return solidContent(ChatView, { props, application });
}
