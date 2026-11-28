import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enSessionNotFound = {
  chat: {
    sessionRoute: {
      notFoundTitle: "Session not found",
      notFoundExplanation: "OpenClaw couldn’t find a session for this link.",
      goToMain: "Go to main session",
      viewSessions: "View sessions",
    },
  },
} satisfies TranslationMap;

export const registerSessionNotFoundEnglish = Object.assign(
  () => mergeCatalog(en, enSessionNotFound),
  { catalog: enSessionNotFound },
);
