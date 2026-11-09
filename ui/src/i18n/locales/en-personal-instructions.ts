import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enPersonalInstructions = {
  profilePage: {
    personalInstructions: {
      signIn: "Sign in with your personal profile to edit your instructions.",
      offline: "Reconnect to edit your instructions.",
      accessRequired:
        "You need permission to view your own sessions to edit your instructions. Ask an admin for access.",
      noAgents: "No agents yet. Ask an admin to add one.",
      guidance:
        "{count} / 4,000 characters. Keep it brief: preferences, context, and working style.",
      missing: "Your personal file will be created when you save.",
      tooLong: "Shorten your instructions to 4,000 characters before saving.",
      reload: "Reload",
      dirty: "Unsaved changes",
      saved: "Saved",
      discard: "Discard your unsaved instructions and load the saved file?",
      discardBody: "Your edits since the last save are lost.",
      discardAction: "Discard",
      failureHint:
        "Your draft is unchanged. If the file changed elsewhere, copy your draft, then reload before saving again.",
      contextChanged:
        "The returned file does not match this profile and agent. Reload before trying again.",
    },
  },
} satisfies TranslationMap;

export const registerPersonalInstructionsEnglish = Object.assign(
  () => {
    // Keep search labels eager; editor-only copy loads with the Profile component.
    Object.assign(
      en.profilePage.personalInstructions,
      enPersonalInstructions.profilePage.personalInstructions,
    );
  },
  { catalog: enPersonalInstructions },
);
