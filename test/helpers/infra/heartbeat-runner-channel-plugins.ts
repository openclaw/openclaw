import type { ChannelPlugin } from "../../../src/channels/plugins/types.public.js";
import { createChannelTestPluginBase } from "../../../src/test-utils/channel-plugins.js";
import { parseTelegramTargetForTest } from "./telegram-targets.js";

/** Historical heartbeat fixtures retain the public Telegram target grammar. */
export const heartbeatRunnerTelegramPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "telegram",
    label: "Telegram",
    docsPath: "/channels/telegram",
  }),
  messaging: {
    inferTargetChatType: ({ to }) => {
      const target = parseTelegramTargetForTest(to);
      return target.chatType === "unknown" ? undefined : target.chatType;
    },
    preserveHeartbeatThreadIdForGroupRoute: true,
  },
};
