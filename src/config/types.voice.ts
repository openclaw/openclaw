/**
 * Voice mode configuration types.
 *
 * Supports local STT (whisper-cpp), local TTS (ElevenLabs sag CLI),
 * model routing integration, and experimental PersonaPlex S2S.
 */

export type VoiceSttProvider = "whisper" | "openai";
export type VoiceTtsProvider = "elevenlabs" | "openai" | "edge" | "macos";

export type VoiceRouterMode = "local" | "cloud" | "auto";

export type VoiceMode = "option2a" | "personaplex" | "hybrid";

export type VoiceWhisperConfig = {
  /** Path to whisper-cpp binary (default: looks in PATH). */
  binaryPath?: string;
  /** Path to GGML model file (e.g., ggml-base.en.bin). */
  modelPath?: string;
  /** Language hint for transcription (default: "en"). */
  language?: string;
  /** Number of threads for whisper-cpp (default: 4). */
  threads?: number;
  /** Timeout in milliseconds (default: 30000). */
  timeoutMs?: number;
};

export type VoiceLocalTtsConfig = {
  /** Use ElevenLabs sag CLI when available. */
  useSag?: boolean;
  /** ElevenLabs voice ID for sag. */
  voiceId?: string;
  /** ElevenLabs model ID for sag. */
  modelId?: string;
  /** Fallback to macOS say command if sag fails. */
  fallbackToMacos?: boolean;
  /** macOS voice name for say command. */
  macosVoice?: string;
  /** Timeout in milliseconds (default: 30000). */
  timeoutMs?: number;
};

export type VoiceRouterConfig = {
  /** Router mode: local (always local), cloud (always cloud), auto (smart routing). */
  mode?: VoiceRouterMode;
  /** Detect sensitive data and route to local models. */
  detectSensitive?: boolean;
  /** Use complexity heuristics for routing. */
  useComplexity?: boolean;
  /** Local model for routing (e.g., llama3:8b). */
  localModel?: string;
  /** Cloud model for routing (default: uses configured cloud provider). */
  cloudModel?: string;
  /** Complexity threshold (0-10) above which to use cloud. */
  complexityThreshold?: number;
};

export type PersonaPlexConfig = {
  /** Enable PersonaPlex S2S (experimental). */
  enabled?: boolean;
  /** Path to PersonaPlex installation. */
  installPath?: string;
  /** Hostname for PersonaPlex server (default: localhost). */
  host?: string;
  /** Server port (default: 8998). */
  port?: number;
  /**
   * WebSocket port for realtime/full-duplex PersonaPlex (moshi.server).
   * Defaults to `port` when running locally, or `port + 1` when configured for remote server + HTTP wrapper.
   *
   * Spark convention:
   * - HTTP wrapper: :8998 (/health, /s2s)
   * - moshi.server: :8999 (/api/chat)
   */
  wsPort?: number;
  /** WebSocket path for realtime PersonaPlex (default: "/api/chat"). */
  wsPath?: string;
  /** Serve PersonaPlex over HTTPS with self-signed certs (recommended). */
  useSsl?: boolean;
  /** Transport selection: auto, offline (local), or server (HTTP). */
  transport?: "auto" | "offline" | "server";
  /** Optional endpoint list for PersonaPlex failover. */
  endpoints?: Array<{
    host?: string;
    port?: number;
    wsPort?: number;
    wsPath?: string;
    useSsl?: boolean;
    transport?: "auto" | "offline" | "server";
    /** Lower numbers are higher priority (default: 0). */
    priority?: number;
    /** Optional health path (default: "/"). */
    healthPath?: string;
    /** Optional health timeout in ms. */
    healthTimeoutMs?: number;
    /** Cache TTL for health checks in ms (default: 10000). */
    healthCacheTtlMs?: number;
  }>;

  /**
   * Prefer using local on-disk model assets (weights, tokenizer, voices, UI dist)
   * instead of downloading from Hugging Face at runtime.
   */
  useLocalAssets?: boolean;

  /** HuggingFace token (reads from keychain if not set). */
  hfToken?: string;

  /** Enable GPU acceleration (MPS on Apple Silicon). */
  useGpu?: boolean;
  /** Device to run on (e.g. "mps", "cpu", "cuda"). */
  device?: string;

  /**
   * Dtype to use for Moshi LM weights.
   * - "fp16" is recommended on Apple Silicon for memory.
   */
  dtype?: "fp16" | "bf16" | "fp32";

  /**
   * Attention context cap (controls KV cache capacity / memory).
   * Lower uses less memory but can reduce coherence.
   */
  context?: number;

  /** Enable CPU offload for Apple Silicon or low VRAM setups. */
  cpuOffload?: boolean;

  /**
   * Use a single Mimi instance instead of two.
   * Not recommended for full duplex.
   */
  singleMimi?: boolean;

  /** Timeout for S2S conversion (ms). */
  timeoutMs?: number;
  /** Stop preloaded PersonaPlex server after this idle period in ms (0 disables idle shutdown). */
  idleTimeoutMs?: number;
  /** Auto-start server on gateway start. */
  autoStart?: boolean;
  /** Optional voice prompt embedding (e.g., NATF2.pt). */
  voicePrompt?: string;
  /** Optional persona text prompt. */
  textPrompt?: string;
  /** Optional seed for offline inference. */
  seed?: number;
};

export type VoiceConfig = {
  /** Voice mode: option2a (local STT+TTS), personaplex (S2S), hybrid (auto-select). */
  mode?: VoiceMode;
  /** Enable voice mode (default: false). */
  enabled?: boolean;
  /** Local STT provider (default: whisper). */
  sttProvider?: VoiceSttProvider;
  /** Local TTS provider (default: elevenlabs via sag). */
  ttsProvider?: VoiceTtsProvider;
  /** Whisper configuration. */
  whisper?: VoiceWhisperConfig;
  /** Local TTS configuration. */
  localTts?: VoiceLocalTtsConfig;
  /** Model router configuration. */
  router?: VoiceRouterConfig;
  /** PersonaPlex S2S configuration (experimental). */
  personaplex?: PersonaPlexConfig;
  /** Enable streaming audio responses. */
  streaming?: boolean;
  /** Audio buffer size in milliseconds (default: 100). */
  bufferMs?: number;
  /** Max recording duration in seconds (default: 60). */
  maxRecordingSeconds?: number;
  /** Voice activity detection sensitivity (0-1, default: 0.5). */
  vadSensitivity?: number;
};

/** Resolved voice configuration with defaults applied. */
export type ResolvedVoiceConfig = Required<
  Omit<VoiceConfig, "whisper" | "localTts" | "router" | "personaplex">
> & {
  whisper: Required<VoiceWhisperConfig>;
  localTts: Required<VoiceLocalTtsConfig>;
  router: Required<VoiceRouterConfig>;
  personaplex: Required<PersonaPlexConfig>;
};

/** Voice session state for WebSocket connections. */
export type VoiceSessionState = {
  sessionId: string;
  mode: VoiceMode;
  isRecording: boolean;
  isProcessing: boolean;
  startedAt?: number;
  lastActivityAt?: number;
  transcription?: string;
  response?: string;
  error?: string;
};
