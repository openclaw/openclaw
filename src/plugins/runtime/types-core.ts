import type { LogLevel } from "../../logging/levels.js";

export type RuntimeLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

export type PluginRuntimeCore = {
  version: string;
  config: {
    loadConfig: typeof import("../../config/config.js").loadConfig;
    writeConfigFile: typeof import("../../config/config.js").writeConfigFile;
  };
  agent: {
    defaults: {
      model: typeof import("../../agents/defaults.js").DEFAULT_MODEL;
      provider: typeof import("../../agents/defaults.js").DEFAULT_PROVIDER;
    };
    resolveAgentDir: typeof import("../../agents/agent-scope.js").resolveAgentDir;
    resolveAgentWorkspaceDir: typeof import("../../agents/agent-scope.js").resolveAgentWorkspaceDir;
    resolveAgentIdentity: typeof import("../../agents/identity.js").resolveAgentIdentity;
    resolveThinkingDefault: typeof import("../../agents/model-selection.js").resolveThinkingDefault;
    runEmbeddedPiAgent: typeof import("../../agents/pi-embedded.js").runEmbeddedPiAgent;
    resolveAgentTimeoutMs: typeof import("../../agents/timeout.js").resolveAgentTimeoutMs;
    ensureAgentWorkspace: typeof import("../../agents/workspace.js").ensureAgentWorkspace;
    session: {
      resolveStorePath: typeof import("../../config/sessions.js").resolveStorePath;
      loadSessionStore: typeof import("../../config/sessions.js").loadSessionStore;
      saveSessionStore: typeof import("../../config/sessions.js").saveSessionStore;
      resolveSessionFilePath: typeof import("../../config/sessions.js").resolveSessionFilePath;
    };
  };
  system: {
    enqueueSystemEvent: typeof import("../../infra/system-events.js").enqueueSystemEvent;
    requestHeartbeatNow: typeof import("../../infra/heartbeat-wake.js").requestHeartbeatNow;
    runCommandWithTimeout: typeof import("../../process/exec.js").runCommandWithTimeout;
    formatNativeDependencyHint: typeof import("./native-deps.js").formatNativeDependencyHint;
  };
  media: {
    loadWebMedia: typeof import("../../../extensions/whatsapp/src/media.js").loadWebMedia;
    detectMime: typeof import("../../media/mime.js").detectMime;
    mediaKindFromMime: typeof import("../../media/constants.js").mediaKindFromMime;
    isVoiceCompatibleAudio: typeof import("../../media/audio.js").isVoiceCompatibleAudio;
    getImageMetadata: typeof import("../../media/image-ops.js").getImageMetadata;
    resizeToJpeg: typeof import("../../media/image-ops.js").resizeToJpeg;
  };
  tts: {
    textToSpeech: typeof import("../../tts/tts.js").textToSpeech;
    textToSpeechTelephony: typeof import("../../tts/tts.js").textToSpeechTelephony;
    listVoices: typeof import("../../tts/tts.js").listSpeechVoices;
  };
  mediaUnderstanding: {
    runFile: typeof import("../../media-understanding/runtime.js").runMediaUnderstandingFile;
    describeImageFile: typeof import("../../media-understanding/runtime.js").describeImageFile;
    describeVideoFile: typeof import("../../media-understanding/runtime.js").describeVideoFile;
    transcribeAudioFile: typeof import("../../media-understanding/runtime.js").transcribeAudioFile;
  };
  webSearch: {
    listProviders: typeof import("../../web-search/runtime.js").listWebSearchProviders;
    search: typeof import("../../web-search/runtime.js").runWebSearch;
  };
  stt: {
    transcribeAudioFile: typeof import("../../media-understanding/transcribe-audio.js").transcribeAudioFile;
  };
  tools: {
    createMemoryGetTool: typeof import("../../agents/tools/memory-tool.js").createMemoryGetTool;
    createMemorySearchTool: typeof import("../../agents/tools/memory-tool.js").createMemorySearchTool;
    registerMemoryCli: typeof import("../../cli/memory-cli.js").registerMemoryCli;
  };
  events: {
    onAgentEvent: typeof import("../../infra/agent-events.js").onAgentEvent;
    onSessionTranscriptUpdate: typeof import("../../sessions/transcript-events.js").onSessionTranscriptUpdate;
  };
  logging: {
    shouldLogVerbose: typeof import("../../globals.js").shouldLogVerbose;
    getChildLogger: (
      bindings?: Record<string, unknown>,
      opts?: { level?: LogLevel },
    ) => RuntimeLogger;
  };
  state: {
    resolveStateDir: typeof import("../../config/paths.js").resolveStateDir;
  };
  modelAuth: {
    /** Resolve auth for a model. Only provider/model and optional cfg are used. */
    getApiKeyForModel: (params: {
      model: import("@mariozechner/pi-ai").Model<import("@mariozechner/pi-ai").Api>;
      cfg?: import("../../config/config.js").OpenClawConfig;
    }) => Promise<import("../../agents/model-auth.js").ResolvedProviderAuth>;
    /** Resolve auth for a provider by name. Only provider and optional cfg are used. */
    resolveApiKeyForProvider: (params: {
      provider: string;
      cfg?: import("../../config/config.js").OpenClawConfig;
    }) => Promise<import("../../agents/model-auth.js").ResolvedProviderAuth>;
  };
};
