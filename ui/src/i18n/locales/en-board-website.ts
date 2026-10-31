import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Website hints load with the widget; its shared kind label stays eager.
const enBoardWebsite = {
  board: {
    widget: {
      websiteOpen: "Open website",
      websiteEmbedHint: "If this site does not load here, open it in a new tab.",
      websiteSameOrigin:
        "Open this website in a new tab. Gateway and Control UI pages cannot be embedded in a website widget.",
    },
  },
} satisfies TranslationMap;

export const registerBoardWebsiteEnglish = Object.assign(
  () => Object.assign(en.board.widget, enBoardWebsite.board.widget),
  { catalog: enBoardWebsite },
);
