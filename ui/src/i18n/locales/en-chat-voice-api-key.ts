import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatVoiceApiKey = {
  chat: {
    voiceApiKey: {
      talk: "Talk needs {apiKey}.",
      dictation: "Dictation needs {apiKey}.",
      voice: "Talk and Dictation need {apiKey}.",
      speech: "Read aloud needs {apiKey}.",
      recording: "Couldn’t transcribe this recording. It needs {apiKey}.",
      openaiKey: "an OpenAI API key",
      providerKey: "an API key for {provider}",
    },
  },
} satisfies TranslationMap;

export const registerChatVoiceApiKeyEnglish = Object.assign(
  () => Object.assign(en.chat, enChatVoiceApiKey.chat),
  { catalog: enChatVoiceApiKey },
);
