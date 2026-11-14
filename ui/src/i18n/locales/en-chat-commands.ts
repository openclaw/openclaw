import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    commands: {
      arguments: "Command arguments",
      menu: "Slash commands",
      optionCount: "{count} options",
      clearDescription: "Clear this conversation",
      redirectDescription: "Restart the agent’s reply with a new message",
      steerDescription: "Guide the agent’s current reply",
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
