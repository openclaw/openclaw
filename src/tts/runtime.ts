// Shared runtime-facing speech helpers. Keep channel/feature plugins on this
// boundary instead of importing the full TTS orchestrator module directly.

export {
	listSpeechVoices,
	textToSpeech,
	textToSpeechTelephony,
} from "./tts.js";
