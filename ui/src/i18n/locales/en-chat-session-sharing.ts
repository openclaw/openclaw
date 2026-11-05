import type { TranslationMap } from "../lib/types.ts";
import { registerChatSessionEnglish } from "./en-chat-session.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    sessionSharing: {
      noPeopleFound: "No people match your search.",
      tryAnotherName: "Try another name",
      visibility: "Visibility",
      publishDraft: "Publish draft",
      noPeople: "No paired people yet.",
      publicAccess: "Public access",
      notPublic: "Only signed-in people with access can view this session.",
      enablePublicAccess: "Enable public access…",
      disablePublicAccess: "Disable public access",
      copyPublicLink: "Copy public link",
      publicConfirmTitle: "Make this session public?",
      publicConfirmMessage:
        "Anyone with the public link can read existing and future conversation text, including all messages, agent replies, and progress, plus tool names, short argument summaries, and images without signing in.\n\nReasoning, tool-result text, and private dashboards stay hidden. Image contents are not redacted. Review for private information before sharing; disabling access cannot recall downloaded copies.",
      publicConfirmEnable: "Make public",
      publicEnabled: "Public access enabled. Copy the public link from session sharing.",
      publicDisabled: "Public access disabled.",
    },
  },
} satisfies TranslationMap;

export const registerChatSessionSharingEnglish = Object.assign(
  () => {
    registerChatSessionEnglish();
    Object.assign(en.chat.sessionSharing, catalog.chat.sessionSharing);
  },
  { catalog },
);
