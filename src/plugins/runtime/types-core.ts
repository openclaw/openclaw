import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import type { LogLevel } from "../../logging/levels.js";

export type { HeartbeatRunResult };

/** Structured logger surface injected into runtime-backed plugin helpers. */
export type RuntimeLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

export type RunHeartbeatOnceOptions = {
  reason?: string;
  agentId?: string;
  sessionKey?: string;
  /** Override heartbeat config (e.g. `{ target: "last" }` to deliver to the last active channel). */
  heartbeat?: { target?: string };
};

/** Core runtime helpers exposed to trusted native plugins. */
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
    /**
     * Run a single heartbeat cycle immediately (bypassing the coalesce timer).
     * Accepts an optional `heartbeat` config override so callers can force
     * delivery to the last active channel — the same pattern the cron service
     * uses to avoid the default `target: "none"` suppression.
     */
    runHeartbeatOnce: (opts?: RunHeartbeatOnceOptions) => Promise<HeartbeatRunResult>;
    runCommandWithTimeout: typeof import("../../process/exec.js").runCommandWithTimeout;
    formatNativeDependencyHint: typeof import("./native-deps.js").formatNativeDependencyHint;
  };
  media: {
    loadWebMedia: typeof import("../../media/web-media.js").loadWebMedia;
    detectMime: typeof import("../../media/mime.js").detectMime;
    mediaKindFromMime: typeof import("../../media/constants.js").mediaKindFromMime;
    isVoiceCompatibleAudio: typeof import("../../media/audio.js").isVoiceCompatibleAudio;
    getImageMetadata: typeof import("../../media/image-ops.js").getImageMetadata;
    resizeToJpeg: typeof import("../../media/image-ops.js").resizeToJpeg;
  };
  tts: {
    textToSpeech: typeof import("../../plugin-sdk/speech-runtime.js").textToSpeech;
    textToSpeechTelephony: typeof import("../../plugin-sdk/speech-runtime.js").textToSpeechTelephony;
    listVoices: typeof import("../../plugin-sdk/speech-runtime.js").listSpeechVoices;
  };
  mediaUnderstanding: {
    runFile: typeof import("../../plugin-sdk/media-understanding-runtime.js").runMediaUnderstandingFile;
    describeImageFile: typeof import("../../plugin-sdk/media-understanding-runtime.js").describeImageFile;
    describeImageFileWithModel: typeof import("../../plugin-sdk/media-understanding-runtime.js").describeImageFileWithModel;
    describeVideoFile: typeof import("../../plugin-sdk/media-understanding-runtime.js").describeVideoFile;
    transcribeAudioFile: typeof import("../../plugin-sdk/media-understanding-runtime.js").transcribeAudioFile;
  };
  imageGeneration: {
    generate: typeof import("../../plugin-sdk/image-generation-runtime.js").generateImage;
    listProviders: typeof import("../../plugin-sdk/image-generation-runtime.js").listRuntimeImageGenerationProviders;
  };
  videoGeneration: {
    generate: typeof import("../../plugin-sdk/video-generation-runtime.js").generateVideo;
    listProviders: typeof import("../../plugin-sdk/video-generation-runtime.js").listRuntimeVideoGenerationProviders;
  };
  webSearch: {
    listProviders: typeof import("../../web-search/runtime.js").listWebSearchProviders;
    search: typeof import("../../web-search/runtime.js").runWebSearch;
  };
  stt: {
    transcribeAudioFile: typeof import("../../media-understanding/transcribe-audio.js").transcribeAudioFile;
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
  tasks: {
    runs: import("./runtime-tasks.js").PluginRuntimeTaskRuns;
    flows: import("./runtime-tasks.js").PluginRuntimeTaskFlows;
    /** @deprecated Use runtime.tasks.flows for DTO-based TaskFlow access. */
    flow: import("./runtime-taskflow.js").PluginRuntimeTaskFlow;
  };
  /** @deprecated Use runtime.tasks.flows for DTO-based TaskFlow access. */
  taskFlow: import("./runtime-taskflow.js").PluginRuntimeTaskFlow;
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
