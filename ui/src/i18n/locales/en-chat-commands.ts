import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    commands: {
      arguments: "Command arguments",
      menu: "Slash commands",
      optionCount: "{count} options",
      clearDescription: "Clear chat history",
      redirectDescription: "Abort and restart with a new message",
      steerDescription: "Inject a message into the active run",
      exportDescription: "Download this conversation as Markdown",
      categories: {
        session: "Session",
        model: "Model",
        agents: "Agents",
        tools: "Tools",
      },
    },
  },
} satisfies TranslationMap;

export const registerChatCommandsEnglish = Object.assign(() => mergeCatalog(en, catalog), {
  catalog,
});
