import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceAudioFormat,
  RealtimeVoiceCloseReason,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceRole,
  RealtimeVoiceTool,
  RealtimeVoiceToolCallEvent,
  RealtimeVoiceToolResultOptions,
} from "./provider-types.js";

/**
 * 实时语音音频接收器类型
 * 定义音频输出的接口
 */
export type RealtimeVoiceAudioSink = {
  isOpen?: () => boolean;
  sendAudio: (audio: Buffer) => void;
  clearAudio?: () => void;
  sendMark?: (markName: string) => void;
};

/**
 * 标记策略类型
 * transport: 通过传输层处理标记
 * ack-immediately: 立即确认
 * ignore: 忽略标记
 */
export type RealtimeVoiceMarkStrategy = "transport" | "ack-immediately" | "ignore";

/**
 * 实时语音桥接会话类型
 * 提供与实时语音桥接交互的接口
 */
export type RealtimeVoiceBridgeSession = {
  bridge: RealtimeVoiceBridge;
  acknowledgeMark(): void;
  close(): void;
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  sendUserMessage(text: string): void;
  setMediaTimestamp(ts: number): void;
  submitToolResult(callId: string, result: unknown, options?: RealtimeVoiceToolResultOptions): void;
  triggerGreeting(instructions?: string): void;
};

/**
 * 创建实时语音桥接会话的参数
 */
export type RealtimeVoiceBridgeSessionParams = {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  audioFormat?: RealtimeVoiceAudioFormat;
  audioSink: RealtimeVoiceAudioSink;
  instructions?: string;
  initialGreetingInstructions?: string;
  markStrategy?: RealtimeVoiceMarkStrategy;
  triggerGreetingOnReady?: boolean;
  tools?: RealtimeVoiceTool[];
  onTranscript?: (role: RealtimeVoiceRole, text: string, isFinal: boolean) => void;
  onToolCall?: (event: RealtimeVoiceToolCallEvent, session: RealtimeVoiceBridgeSession) => void;
  onReady?: (session: RealtimeVoiceBridgeSession) => void;
  onError?: (error: Error) => void;
  onClose?: (reason: RealtimeVoiceCloseReason) => void;
};

/**
 * 创建实时语音桥接会话
 * @param params - 会话参数
 * @returns 桥接会话对象
 */
export function createRealtimeVoiceBridgeSession(
  params: RealtimeVoiceBridgeSessionParams,
): RealtimeVoiceBridgeSession {
  let bridge: RealtimeVoiceBridge | undefined;
  const requireBridge = () => {
    if (!bridge) {
      throw new Error("Realtime voice bridge is not ready");
    }
    return bridge;
  };
  const session: RealtimeVoiceBridgeSession = {
    get bridge() {
      return requireBridge();
    },
    acknowledgeMark: () => requireBridge().acknowledgeMark(),
    close: () => requireBridge().close(),
    connect: () => requireBridge().connect(),
    sendAudio: (audio) => requireBridge().sendAudio(audio),
    sendUserMessage: (text) => requireBridge().sendUserMessage?.(text),
    setMediaTimestamp: (ts) => requireBridge().setMediaTimestamp(ts),
    submitToolResult: (callId, result, options) =>
      requireBridge().submitToolResult(callId, result, options),
    triggerGreeting: (instructions) => requireBridge().triggerGreeting?.(instructions),
  };
  const canSendAudio = () => params.audioSink.isOpen?.() ?? true;
  bridge = params.provider.createBridge({
    providerConfig: params.providerConfig,
    audioFormat: params.audioFormat,
    instructions: params.instructions,
    tools: params.tools,
    onAudio: (audio) => {
      if (canSendAudio()) {
        params.audioSink.sendAudio(audio);
      }
    },
    onClearAudio: () => {
      if (canSendAudio()) {
        params.audioSink.clearAudio?.();
      }
    },
    onMark: (markName) => {
      if (!canSendAudio() || params.markStrategy === "ignore") {
        return;
      }
      if (params.markStrategy === "ack-immediately") {
        bridge?.acknowledgeMark();
        return;
      }
      if (params.markStrategy === undefined || params.markStrategy === "transport") {
        params.audioSink.sendMark?.(markName);
      }
    },
    onTranscript: params.onTranscript,
    onToolCall: (event) => {
      if (!bridge) {
        return;
      }
      params.onToolCall?.(event, session);
    },
    onReady: () => {
      if (!bridge) {
        return;
      }
      if (params.triggerGreetingOnReady) {
        bridge.triggerGreeting?.(params.initialGreetingInstructions);
      }
      params.onReady?.(session);
    },
    onError: params.onError,
    onClose: params.onClose,
  });

  return session;
}
