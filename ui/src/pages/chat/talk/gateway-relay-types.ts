import type { TalkRealtimeRelayEventPayload } from "../../../../../src/gateway/talk/relay/state.js";
import type { RealtimeTalkEvent } from "./shared.ts";

export type GatewayRelayEvent = {
  talkEvent?: RealtimeTalkEvent;
} & (
  | Partial<Exclude<TalkRealtimeRelayEventPayload, { type: "close" }>>
  | { relaySessionId?: string; type?: "close"; reason?: string }
);

export type DelayedToolResult = {
  callId: string;
  result: unknown;
  options?: { suppressResponse?: boolean; willContinue?: boolean };
  timer?: number;
};
