import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import type { LogLevel } from "../../logging/levels.js";

export type { HeartbeatRunResult };

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

export type PluginRuntimeCore = {
  version: string;
  config: {
    loadConfig: typeof import("../../config/config.js").loadConfig;
    writeConfigFile: typeof import("../../config/config.js").writeConfigFile;
  };
  system: {
    enqueueSystemEvent: typeof import("../../infra/system-events.js").enqueueSystemEvent;
    requestHeartbeatNow: typeof import("../../infra/heartbeat-wake.js").requestHeartbeatNow;
    /**
     * Run a single heartbeat cycle synchronously (bypassing the coalesce timer).
     * Run a single heartbeat cycle immediately (bypassing the coalesce timer).
     * delivery to the last active channel — the same pattern the cron service
     * uses to avoid the default `target: "none"` suppression.
     */
    runHeartbeatOnce: (opts?: RunHeartbeatOnceOptions) => Promise<HeartbeatRunResult>;
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
    textToSpeechTelephony: typeof import("../../tts/tts.js").textToSpeechTelephony;
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
