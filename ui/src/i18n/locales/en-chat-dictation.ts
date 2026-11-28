import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Loads with dictation capture; keep it out of the composer's startup copy.
const enChatDictation = {
  chat: {
    dictation: {
      busy: "Dictation is busy finishing earlier recordings. Try again in a moment.",
      refinementOptions: "Dictation text options",
      refinementEnable: "Review dictated text before inserting",
      refinementLocalScope:
        "Conservative text cleanup runs on this device. Speech recognition still uses your selected transcription provider.",
      refinementModelUnavailable: "Model-assisted text refinement is unavailable in this build.",
      refinementFinishing: "Finishing text. The microphone is off.",
      refinementReady: "Text is ready to review. Nothing has been sent.",
      refinementRaw: "Raw transcript — refinement unavailable. Review it before inserting.",
      refinementReview: "Review the suggested changes carefully before using them.",
      refinementCancelled: "Text refinement cancelled. Your draft is preserved.",
      refinementUnavailable:
        "A complete transcript is unavailable. You can recover an incomplete caption manually or record again.",
      refinementLimit:
        "This transcript exceeds the text review limit. No text was inserted. Record a shorter passage.",
      refinementCaption: "Provisional caption",
      refinementPreview: "Text preview",
      refinementInspect: "Inspect changes",
      refinementOriginal: "Original finalized transcript",
      refinementMeaning:
        "Automatic checks cannot guarantee that every change preserves your meaning.",
      refinementKeepRaw: "Keep raw transcript",
      refinementUse: "Use reviewed text",
      refinementIncomplete: "Incomplete caption — manual recovery only",
      refinementCancel: "Cancel text refinement",
    },
  },
} satisfies TranslationMap;

export const registerChatDictationEnglish = Object.assign(
  () => Object.assign(en.chat, enChatDictation.chat),
  { catalog: enChatDictation },
);
