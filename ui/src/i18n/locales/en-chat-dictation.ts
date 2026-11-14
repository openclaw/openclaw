import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    composer: {
      dictationAudioUnsupported: "The Gateway returned an unsupported dictation audio format.",
      dictationBrowserAudioUnsupported: "This browser cannot capture dictation audio at 8 kHz.",
      dictationFailed: "Couldn’t transcribe your voice.",
      dictationRetryRecording: "Retry recording",
      dictationDiscardRecording: "Discard recording",
      dictationRecordingKept:
        "No transcript received. This recording is kept in this tab for retry.",
      dictationStarting: "Starting microphone…",
    },
  },
} satisfies TranslationMap;

export const registerChatDictationEnglish = Object.assign(() => mergeCatalog(en, catalog), {
  catalog,
});
