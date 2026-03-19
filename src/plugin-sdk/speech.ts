// Public speech-provider builders for bundled or third-party plugins.

export { buildElevenLabsSpeechProvider } from "../tts/providers/elevenlabs.js";
export { buildMicrosoftSpeechProvider } from "../tts/providers/microsoft.js";
export { buildOpenAISpeechProvider } from "../tts/providers/openai.js";
export { parseTtsDirectives } from "../tts/tts-core.js";
export type { SpeechVoiceOption } from "../tts/provider-types.js";
