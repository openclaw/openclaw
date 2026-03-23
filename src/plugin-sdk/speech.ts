// Public speech-provider builders for bundled or third-party plugins.

export { buildElevenLabsSpeechProvider } from "../../extensions/elevenlabs/speech-provider.js";
export { buildMicrosoftSpeechProvider } from "../../extensions/microsoft/speech-provider.js";
export { buildOpenAISpeechProvider } from "../../extensions/openai/speech-provider.js";
export { parseTtsDirectives } from "../tts/tts-core.js";
export type { SpeechVoiceOption } from "../tts/provider-types.js";
