import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatVoiceApiKey = {
  chat: {
    voiceApiKey: {
      talk: "{provider} Talk needs an API key",
      dictation: "{provider} dictation needs an API key",
      voice: "{provider} voice needs an API key",
      speech: "{provider} speech needs an API key",
      recording: "Couldn’t transcribe this recording with {provider}",
      detail: "Sign in with ChatGPT doesn’t include voice.",
    },
  },
} satisfies TranslationMap;

export const registerChatVoiceApiKeyEnglish = Object.assign(
  () => Object.assign(en.chat, enChatVoiceApiKey.chat),
  { catalog: enChatVoiceApiKey },
);
