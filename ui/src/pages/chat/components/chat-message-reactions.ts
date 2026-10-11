import { solidContent } from "../../../lit/solid-content.tsx";
import {
  GroupMessageReactions,
  type renderSolidGroupMessageReactions,
} from "./chat-message-reaction-chips-view.tsx";

export function renderGroupMessageReactions(
  ...args: Parameters<typeof renderSolidGroupMessageReactions>
) {
  return solidContent(GroupMessageReactions, {
    group: args[0],
    actionDetails: args[1],
    isStreaming: args[2],
    options: args[3],
  });
}
