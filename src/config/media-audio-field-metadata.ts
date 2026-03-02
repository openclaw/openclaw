export const MEDIA_AUDIO_FIELD_KEYS = [
  "tools.media.audio.enabled",
  "tools.media.audio.maxBytes",
  "tools.media.audio.maxChars",
  "tools.media.audio.prompt",
  "tools.media.audio.timeoutSeconds",
  "tools.media.audio.language",
  "tools.media.audio.attachments",
  "tools.media.audio.models",
  "tools.media.audio.scope",
  "tools.media.audio.echoTranscript",
  "tools.media.audio.echoFormat",
] as const;

type MediaAudioFieldKey = (typeof MEDIA_AUDIO_FIELD_KEYS)[number];

export const MEDIA_AUDIO_FIELD_HELP: Record<MediaAudioFieldKey, string> = {
  "tools.media.audio.enabled":
    "Enable audio understanding so voice notes or audio clips can be transcribed/summarized for agent context. Disable when audio ingestion is outside policy or unnecessary for your workflows.",
  "tools.media.audio.maxBytes":
    "Maximum accepted audio payload size in bytes before processing is rejected or clipped by policy. Set this based on expected recording length and upstream provider limits.",
  "tools.media.audio.maxChars":
    "Maximum characters retained from audio understanding output to prevent oversized transcript injection. Increase for long-form dictation, or lower to keep conversational turns compact.",
  "tools.media.audio.prompt":
    "Instruction template guiding audio understanding output style, such as concise summary versus near-verbatim transcript. Keep wording consistent so downstream automations can rely on output format.",
  "tools.media.audio.timeoutSeconds":
    "Timeout in seconds for audio understanding execution before the operation is cancelled. Use longer timeouts for long recordings and tighter ones for interactive chat responsiveness.",
  "tools.media.audio.language":
    "Preferred language hint for audio understanding/transcription when provider support is available. Set this to improve recognition accuracy for known primary languages.",
  "tools.media.audio.attachments":
    "Attachment policy for audio inputs indicating which uploaded files are eligible for audio processing. Keep restrictive defaults in mixed-content channels to avoid unintended audio workloads.",
  "tools.media.audio.models":
    "Ordered model preferences specifically for audio understanding, used before shared media model fallback. Choose models optimized for transcription quality in your primary language/domain.",
  "tools.media.audio.scope":
    "Scope selector for when audio understanding runs across inbound messages and attachments. Keep focused scopes in high-volume channels to reduce cost and avoid accidental transcription.",
  "tools.media.audio.echoTranscript":
    "Echo the audio transcript back to the originating chat before agent processing. When enabled, users immediately see what was heard from their voice note, helping them verify transcription accuracy before the agent acts on it. Default: false.",
  "tools.media.audio.echoFormat":
    "Format string for the echoed transcript message. Use `{transcript}` as a placeholder for the transcribed text. Default: '📝 \"{transcript}\"'.",
};

export const MEDIA_AUDIO_FIELD_LABELS: Record<MediaAudioFieldKey, string> = {
  "tools.media.audio.enabled": "Enable Audio Understanding",
  "tools.media.audio.maxBytes": "Audio Understanding Max Bytes",
  "tools.media.audio.maxChars": "Audio Understanding Max Chars",
  "tools.media.audio.prompt": "Audio Understanding Prompt",
  "tools.media.audio.timeoutSeconds": "Audio Understanding Timeout (sec)",
  "tools.media.audio.language": "Audio Understanding Language",
  "tools.media.audio.attachments": "Audio Understanding Attachment Policy",
  "tools.media.audio.models": "Audio Understanding Models",
  "tools.media.audio.scope": "Audio Understanding Scope",
  "tools.media.audio.echoTranscript": "Echo Transcript to Chat",
  "tools.media.audio.echoFormat": "Transcript Echo Format",
};
