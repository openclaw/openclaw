import {
  deleteMessageMSTeams as deleteMessageMSTeamsImpl,
  editChannelMSTeams as editChannelMSTeamsImpl,
  editMessageMSTeams as editMessageMSTeamsImpl,
  sendAdaptiveCardMSTeams as sendAdaptiveCardMSTeamsImpl,
  sendMessageMSTeams as sendMessageMSTeamsImpl,
  sendTypingMSTeams as sendTypingMSTeamsImpl,
} from "../../plugin-sdk/msteams.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

type RuntimeMSTeamsOps = Pick<
  PluginRuntimeChannel["msteams"],
  "sendMessageMSTeams" | "sendAdaptiveCardMSTeams"
> & {
  typing: Pick<PluginRuntimeChannel["msteams"]["typing"], "pulse">;
  conversationActions: Pick<
    PluginRuntimeChannel["msteams"]["conversationActions"],
    "editMessage" | "deleteMessage" | "editChannel"
  >;
};

export const runtimeMSTeamsOps = {
  sendMessageMSTeams: sendMessageMSTeamsImpl,
  sendAdaptiveCardMSTeams: sendAdaptiveCardMSTeamsImpl,
  typing: {
    pulse: sendTypingMSTeamsImpl,
  },
  conversationActions: {
    editMessage: editMessageMSTeamsImpl,
    deleteMessage: deleteMessageMSTeamsImpl,
    editChannel: editChannelMSTeamsImpl,
  },
} satisfies RuntimeMSTeamsOps;
