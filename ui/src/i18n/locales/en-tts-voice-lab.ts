import { en } from "./en.ts";

/** Keys live in en.ts so the Control UI catalog verifier can see them. */
export const registerTtsVoiceLabEnglish = () => {
  void en.ttsVoiceLab;
};
