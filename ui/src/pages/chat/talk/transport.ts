import { normalizeTalkTransport } from "../../../../../src/talk/talk-session-controller.js";
import type { RealtimeTalkSessionResult } from "./shared.ts";

export type RealtimeTalkLaunchTransport =
  | "webrtc"
  | "provider-websocket"
  | "gateway-relay"
  | "managed-room";

export function normalizeLaunchTransport(value: unknown): RealtimeTalkLaunchTransport | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const transport = normalizeTalkTransport(value);
  if (
    transport === "webrtc" ||
    transport === "provider-websocket" ||
    transport === "gateway-relay" ||
    transport === "managed-room"
  ) {
    return transport;
  }
  return undefined;
}

export function resolveRealtimeTalkTransport(session: RealtimeTalkSessionResult): string {
  return normalizeTalkTransport(session.transport) ?? "webrtc";
}
