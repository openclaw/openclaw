import { solidContent } from "../../../lit/solid-content.tsx";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import type { ChatMessageRenderPreparation } from "./chat-message-markdown.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
export * from "./chat-message-bubble-view.tsx";

export function renderGroupedMessage(
  preparation: ChatMessageRenderPreparation,
  messageKey: string,
  options: GroupedMessageOptions,
  onOpenSidebar?: (content: SidebarContent) => void,
) {
  return solidContent(GroupedMessage, { preparation, messageKey, options, onOpenSidebar });
}
