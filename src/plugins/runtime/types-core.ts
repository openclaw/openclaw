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
  system: {
    enqueueSystemEvent: typeof import("../../infra/system-events.js").enqueueSystemEvent;
    requestHeartbeatNow: typeof import("../../infra/heartbeat-wake.js").requestHeartbeatNow;
    runCommandWithTimeout: typeof import("../../process/exec.js").runCommandWithTimeout;
    formatNativeDependencyHint: typeof import("./native-deps.js").formatNativeDependencyHint;
  };
  media: {
    loadWebMedia: typeof import("../../web/media.js").loadWebMedia;
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
  hooks: {
    /**
     * Emit a message_sent plugin hook event.
     * Use this from extensions that bypass the core deliverOutboundPayloads pipeline
     * (e.g. channel-specific reply dispatchers) so downstream plugins (bot-company
     * journal, analytics, etc.) can still observe outbound messages.
     */
    emitMessageSent: (
      event: {
        to: string;
        content: string;
        success: boolean;
        messageId?: string;
        error?: string;
        metadata?: Record<string, unknown>;
      },
      context: {
        channelId: string;
        accountId?: string;
        conversationId?: string;
      },
    ) => void;
  };
  state: {
    resolveStateDir: typeof import("../../config/paths.js").resolveStateDir;
  };
};
