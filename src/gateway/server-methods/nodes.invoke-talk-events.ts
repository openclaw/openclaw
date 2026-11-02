import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { GatewayRequestContext } from "./shared-types.js";

const TALK_PTT_EVENT_TYPES = new Map([
  ["talk.ptt.start", "capture.started"],
  ["talk.ptt.stop", "capture.stopped"],
  ["talk.ptt.cancel", "capture.cancelled"],
  ["talk.ptt.once", "capture.once"],
]);
const talkPttEventSeqBySessionId = new Map<string, number>();

export function emitTalkPttNodeEvent(params: {
  context: Pick<GatewayRequestContext, "broadcast">;
  nodeId: string;
  command: string;
  payload: unknown;
}): void {
  const type = TALK_PTT_EVENT_TYPES.get(params.command);
  if (!type) {
    return;
  }
  const payloadObj =
    typeof params.payload === "object" && params.payload !== null
      ? (params.payload as Record<string, unknown>)
      : {};
  const captureId = normalizeOptionalString(payloadObj.captureId) ?? randomUUID();
  const sessionId = `node:${params.nodeId}:talk:${captureId}`;
  const seq = (talkPttEventSeqBySessionId.get(sessionId) ?? 0) + 1;
  talkPttEventSeqBySessionId.set(sessionId, seq);
  pruneMapToMaxSize(talkPttEventSeqBySessionId, 2048);

  const final = params.command !== "talk.ptt.start";
  const talkEvent = {
    id: `${sessionId}:${seq}`,
    type,
    sessionId,
    captureId,
    seq,
    timestamp: new Date().toISOString(),
    mode: "stt-tts",
    transport: "managed-room",
    brain: "agent-consult",
    final,
    payload: {
      nodeId: params.nodeId,
      command: params.command,
      status: normalizeOptionalString(payloadObj.status) ?? undefined,
      transcript: normalizeOptionalString(payloadObj.transcript) ?? undefined,
    },
  };
  params.context.broadcast(
    "talk.event",
    { nodeId: params.nodeId, command: params.command, talkEvent },
    { dropIfSlow: true },
  );
}
