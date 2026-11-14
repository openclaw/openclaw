import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enQuestionStore = {
  chat: {
    questions: {
      storePrivacy: "Saved outside chat. The agent cannot read the value.",
      storeSave: "Save credential",
      storeSaving: "Saving credential…",
      storeSaved: "Credential saved",
      storeDone: "Return to your conversation.",
      storeRequestedBy: "Requested by {agent}",
      storeRequest: "{agent} needs a credential",
      storeDetails: "Credential details",
      storeHosts: "Allowed outbound hosts",
      storeHostsHint: "Controls outbound substitutions; config references are separate.",
      storeEntry: "Stores {name} as {kind}",
      storeReplacement: "Replaces the saved value · updated {updated}",
      storeReplacementBy: "Replaces the saved value · updated {updated} by {updatedBy}",
    },
  },
} satisfies TranslationMap;

export const registerQuestionStoreEnglish = Object.assign(
  () => {
    Object.assign(en.chat.questions, enQuestionStore.chat.questions);
  },
  { catalog: enQuestionStore },
);
