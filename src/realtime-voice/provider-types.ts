import type { OpenClawConfig } from "../config/types.openclaw.js";

export type RealtimeVoiceProviderId = string;

export type RealtimeVoiceRole = "user" | "assistant";

export type RealtimeVoiceCloseReason = "completed" | "error";

export type RealtimeVoiceTool = {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type RealtimeVoiceToolCallEvent = {
  itemId: string;
  callId: string;
  name: string;
  args: unknown;
};

export type RealtimeVoiceBridgeCallbacks = {
  onAudio: (muLaw: Buffer) => void;
  onClearAudio: () => void;
  onMark?: (markName: string) => void;
  onTranscript?: (role: RealtimeVoiceRole, text: string, isFinal: boolean) => void;
  onToolCall?: (event: RealtimeVoiceToolCallEvent) => void;
  onReady?: () => void;
  onError?: (error: Error) => void;
  onClose?: (reason: RealtimeVoiceCloseReason) => void;
};

export type RealtimeVoiceProviderConfig = Record<string, unknown>;

export type RealtimeVoiceProviderResolveConfigContext = {
  cfg: OpenClawConfig;
  rawConfig: RealtimeVoiceProviderConfig;
};

export type RealtimeVoiceProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
};

/**
 * MIME types accepted by `sendVideoFrame` and `videoConfig.mimeType`.
 *
 * Providers that grow support for additional formats can extend the union
 * upstream; clients should pass the format the provider advertised in the
 * matching `videoConfig` slot when one was supplied.
 */
export type RealtimeVoiceVideoFrameMimeType = "image/jpeg" | "image/png";

export type RealtimeVoiceVideoFrameOptions = {
  mimeType: RealtimeVoiceVideoFrameMimeType;
  /** Capture timestamp (ms since epoch). Optional; providers may ignore. */
  ts?: number;
};

export type RealtimeVoiceBridgeCreateRequest = RealtimeVoiceBridgeCallbacks & {
  providerConfig: RealtimeVoiceProviderConfig;
  instructions?: string;
  tools?: RealtimeVoiceTool[];
  /**
   * Optional. Hint the provider about the video stream the client plans to
   * push so it can pre-size buffers, configure the model, or surface a
   * "vision unsupported" error early. Frames may still be sent without this,
   * but providers may reject or downgrade quality.
   */
  videoConfig?: {
    mimeType: RealtimeVoiceVideoFrameMimeType;
    /** Approximate frame rate the client expects to push. */
    fps?: number;
    /** Width / height in pixels (informational only). */
    width?: number;
    height?: number;
  };
};

export type RealtimeVoiceBrowserSessionCreateRequest = {
  providerConfig: RealtimeVoiceProviderConfig;
  instructions?: string;
  tools?: RealtimeVoiceTool[];
  model?: string;
  voice?: string;
};

export type RealtimeVoiceBrowserSession = {
  provider: RealtimeVoiceProviderId;
  clientSecret: string;
  model?: string;
  voice?: string;
  expiresAt?: number;
};

export type RealtimeVoiceBridge = {
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  setMediaTimestamp(ts: number): void;
  sendUserMessage?(text: string): void;
  triggerGreeting?(instructions?: string): void;
  submitToolResult(callId: string, result: unknown): void;
  acknowledgeMark(): void;
  close(): void;
  isConnected(): boolean;
  /**
   * Optional. Send a single video frame (screen / camera capture) to the
   * provider. Providers without vision support should leave this undefined;
   * clients must check before calling. Use `videoConfig` on the create
   * request to negotiate format and rate up front.
   */
  sendVideoFrame?(frame: Buffer, opts: RealtimeVoiceVideoFrameOptions): void;
};
