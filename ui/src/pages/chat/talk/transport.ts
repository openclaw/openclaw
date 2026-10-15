import { normalizeTalkTransport } from "../../../../../src/talk/talk-session-controller.js";
import type { RealtimeTalkSessionResult } from "./shared.ts";

export type RealtimeTalkLaunchTransport = RealtimeTalkSessionResult["transport"];

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
