import {
  createLazyRuntimeMethodBinder,
  createLazyRuntimeSurface,
} from "../../shared/lazy-runtime.js";
import { createMSTeamsTypingLease } from "./runtime-msteams-typing.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

const loadRuntimeMSTeamsOps = createLazyRuntimeSurface(
  () => import("./runtime-msteams-ops.runtime.js"),
  ({ runtimeMSTeamsOps }) => runtimeMSTeamsOps,
);

const bindMSTeamsRuntimeMethod = createLazyRuntimeMethodBinder(loadRuntimeMSTeamsOps);

const sendMessageMSTeamsLazy = bindMSTeamsRuntimeMethod(
  (runtimeMSTeamsOps) => runtimeMSTeamsOps.sendMessageMSTeams,
);
const sendAdaptiveCardMSTeamsLazy = bindMSTeamsRuntimeMethod(
  (runtimeMSTeamsOps) => runtimeMSTeamsOps.sendAdaptiveCardMSTeams,
);
const sendTypingMSTeamsLazy = bindMSTeamsRuntimeMethod(
  (runtimeMSTeamsOps) => runtimeMSTeamsOps.typing.pulse,
);
const editMessageMSTeamsLazy = bindMSTeamsRuntimeMethod(
  (runtimeMSTeamsOps) => runtimeMSTeamsOps.conversationActions.editMessage,
);
const deleteMessageMSTeamsLazy = bindMSTeamsRuntimeMethod(
  (runtimeMSTeamsOps) => runtimeMSTeamsOps.conversationActions.deleteMessage,
);
const editChannelMSTeamsLazy = bindMSTeamsRuntimeMethod(
  (runtimeMSTeamsOps) => runtimeMSTeamsOps.conversationActions.editChannel,
);

export function createRuntimeMSTeams(): PluginRuntimeChannel["msteams"] {
  return {
    sendMessageMSTeams: sendMessageMSTeamsLazy,
    sendAdaptiveCardMSTeams: sendAdaptiveCardMSTeamsLazy,
    typing: {
      pulse: sendTypingMSTeamsLazy,
      start: async ({ to, cfg, intervalMs }) => {
        if (!cfg) {
          throw new Error("msteams typing.start requires cfg");
        }
        return await createMSTeamsTypingLease({
          to,
          cfg,
          intervalMs,
          pulse: async ({ to, cfg }) =>
            await sendTypingMSTeamsLazy({
              to,
              cfg:
                cfg ??
                (() => {
                  throw new Error("msteams typing pulse requires cfg");
                })(),
            }),
        });
      },
    },
    conversationActions: {
      editMessage: editMessageMSTeamsLazy,
      deleteMessage: deleteMessageMSTeamsLazy,
      editChannel: editChannelMSTeamsLazy,
    },
  };
}
