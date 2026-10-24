import type { UsageCostWorkerReply } from "../../infra/session-cost-usage-worker.types.js";
import type {
  SessionTranscriptWorkerValues,
  SessionTranscriptWorkerReply,
} from "./session-transcript-worker.types.js";

export function sessionTranscriptTransferList(
  reply: SessionTranscriptWorkerReply<keyof SessionTranscriptWorkerValues> | UsageCostWorkerReply,
) {
  if (!reply.ok) {
    return [];
  }
  const value = reply.value;
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return [];
  }
  const body =
    value.kind === "rpc"
      ? value.page.encodedResponse?.messages
      : value.kind === "artifacts" && value.result.kind === "download-response"
        ? value.result.response?.body
        : undefined;
  const deflated = value.kind === "rpc" ? value.page.encodedMessagesDeflate : undefined;
  const activity = value.kind === "rpc" ? value.page.encodedResponse?.activity : undefined;
  return [body?.buffer, deflated?.buffer, activity?.buffer].filter(
    (buffer) => buffer !== undefined,
  );
}
