import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/** Stored with the result-bearing message; never grants execution or replay authority. */
export type RequesterDeliveryReceipt = { runId: string; inputIdempotencyKey: string };

export function readRequesterDeliveryReceipt(value: unknown): RequesterDeliveryReceipt | undefined {
  const event = asOptionalRecord(value);
  const message = asOptionalRecord(event?.message) ?? event;
  const metadata = asOptionalRecord(message?.details ?? message?.["__openclaw"]);
  const receipt = asOptionalRecord(metadata?.requesterDelivery);
  const provenance = asOptionalRecord(message?.provenance);
  const runId =
    receipt?.runId ??
    (provenance?.kind === "inter_session" &&
    (provenance.sourceTool === "subagent_announce" || provenance.sourceTool === "subagent_settle")
      ? metadata?.runId
      : undefined);
  const inputIdempotencyKey = receipt?.inputIdempotencyKey ?? message?.idempotencyKey;
  return typeof runId === "string" && typeof inputIdempotencyKey === "string"
    ? { runId, inputIdempotencyKey }
    : undefined;
}

export function requesterDeliveryReceiptKey(inputIdempotencyKey: string): string {
  return `requester-delivery:${inputIdempotencyKey}`;
}
