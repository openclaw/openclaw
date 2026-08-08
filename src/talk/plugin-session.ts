export const PLUGIN_TALK_AUDIO_FORMAT = {
  encoding: "pcm16le",
  sampleRateHz: 24_000,
  channels: 1,
} as const;

export type PluginTalkSessionEvent =
  | {
      type: "state";
      generation: number;
      ptsMs: number;
      state: "idle" | "listening" | "thinking" | "speaking" | "error";
    }
  | {
      type: "audio";
      generation: number;
      sequence: number;
      ptsMs: number;
      pcm: Uint8Array;
    }
  | {
      type: "clear";
      generation: number;
      reason: "barge-in" | "cancel" | "replace" | "hangup" | "error";
    }
  | {
      type: "closed";
      generation: number;
      reason: "completed" | "error" | "replaced";
    };

export type OpenPluginTalkSessionParams = {
  sessionKey: string;
  provider?: string;
  model?: string;
  voice?: string;
  language?: string;
  onEvent: (event: PluginTalkSessionEvent) => void | Promise<void>;
};

export type PluginTalkSession = {
  readonly audio: typeof PLUGIN_TALK_AUDIO_FORMAT;
  sendAudio(pcm: Uint8Array, options?: { timestamp?: number }): void;
  cancelOutput(reason?: string): void;
  close(): void;
};
