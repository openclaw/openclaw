import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

export type ChatDeliveryObservation = {
  label: string;
  count: number;
  lastChat?: { sessionKey?: string; runId?: string; state?: string };
};

export function formatChatDeliveryOutcomes(
  send: PromiseSettledResult<{ ok: boolean; payload?: unknown; error?: unknown }>,
  delivered: readonly PromiseSettledResult<unknown>[],
  observations: readonly ChatDeliveryObservation[],
): string {
  const sendPayload =
    send.status === "fulfilled" ? asOptionalRecord(send.value.payload) : undefined;
  const sendError = send.status === "fulfilled" ? asOptionalRecord(send.value.error) : undefined;
  return JSON.stringify({
    send: {
      status: send.status,
      ok: send.status === "fulfilled" ? send.value.ok : undefined,
      runId: typeof sendPayload?.runId === "string" ? sendPayload.runId : undefined,
      responseStatus: typeof sendPayload?.status === "string" ? sendPayload.status : undefined,
      errorCode: typeof sendError?.code === "string" ? sendError.code : undefined,
    },
    observers: observations.map((observation, index) => ({
      ...observation,
      status: delivered[index]?.status,
    })),
  });
}

export function recordChatDeliveryFrame(
  observation: ChatDeliveryObservation,
  frame: { type?: string; event?: string; payload?: unknown },
): void {
  if (frame.type === "event" && frame.event === "chat") {
    const payload = asOptionalRecord(frame.payload);
    observation.count += 1;
    observation.lastChat = {
      sessionKey: typeof payload?.sessionKey === "string" ? payload.sessionKey : undefined,
      runId: typeof payload?.runId === "string" ? payload.runId : undefined,
      state: typeof payload?.state === "string" ? payload.state : undefined,
    };
  }
}
