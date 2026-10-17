import type { RealtimeVoiceAgentControlResult } from "../../../talk/agent-run-control.js";
import type { RealtimeVoiceAudioClearReason } from "../../../talk/provider-types.js";

export type TalkRealtimeRelayEventData =
  | { type: "ready" }
  | { type: "responseStarted"; turnId: string }
  | { type: "inputAudio"; byteLength: number }
  | {
      type: "audio";
      audioBase64: string;
      itemId?: string;
      responseId?: string;
    }
  | { type: "audioStarted"; outputId: number }
  | {
      type: "audioDone";
      itemId?: string;
      responseId?: string;
      status?: "completed" | "cancelled" | "failed" | "incomplete";
    }
  | { type: "clear"; reason?: RealtimeVoiceAudioClearReason }
  | { type: "mark"; markName: string }
  | {
      type: "transcript";
      role: "user" | "assistant";
      text: string;
      final: boolean;
      textMode?: "snapshot";
      transcriptId?: string;
    }
  | {
      type: "toolCall";
      itemId: string;
      callId: string;
      name: string;
      args: unknown;
      forced?: boolean;
    }
  | { type: "toolCallCancelled"; callId: string }
  | { type: "toolResult"; callId: string }
  | { type: "toolProgress"; result: RealtimeVoiceAgentControlResult }
  | {
      type: "error";
      message: string;
      code?: "realtime_unavailable";
      provider?: string;
      model?: string;
      transport?: "gateway-relay";
      phase?: string;
    }
  | { type: "close"; reason: "completed" | "error" };
