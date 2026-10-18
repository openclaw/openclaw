import { listMessageReceiptSourceTargets } from "../../channels/message/receipt.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import type { DeliveryPlacementEvidence } from "./delivery-placement-evidence.types.js";

export type { DeliveryPlacementEvidence } from "./delivery-placement-evidence.types.js";

/** One logical payload retains every observation before adapter/user callbacks can mutate it. */
export function createDeliveryPlacementEvidenceRecorder() {
  const channels = new Set<string>();
  const targets = new Set<string>();
  const threads = new Set<string>();
  let invalid = false;
  return {
    observe(result: OutboundDeliveryResult) {
      for (const target of listMessageReceiptSourceTargets(result)) {
        targets.add(target);
      }
      const seen = new Set<object>();
      const pending: unknown[] = [result];
      for (const item of pending) {
        if (!item || typeof item !== "object" || seen.has(item)) {
          continue;
        }
        seen.add(item);
        if (Array.isArray(item)) {
          pending.push(...item);
          continue;
        }
        // SAFETY: only optional receipt fields are read after excluding primitives and arrays.
        const record = item as Record<string, unknown>;
        invalid ||= record.outcome === "not_sent";
        if (record.channel !== undefined) {
          if (typeof record.channel === "string") {
            if (record.channel.trim()) {
              channels.add(record.channel.trim());
            }
          } else {
            invalid = true;
          }
        }
        if (Array.isArray(record.sourceResults)) {
          for (const source of record.sourceResults) {
            invalid ||=
              !source ||
              source.outcome === "not_sent" ||
              typeof source.messageId !== "string" ||
              !source.messageId.trim();
          }
          pending.push(...record.sourceResults);
        }
        if (record.threadId !== undefined && record.threadId !== null) {
          if (typeof record.threadId === "string" || typeof record.threadId === "number") {
            threads.add(String(record.threadId).trim());
          } else {
            invalid = true;
          }
        }
        if (Array.isArray(record.parts)) {
          invalid ||= record.parts.some(
            (part) =>
              !part || typeof part.platformMessageId !== "string" || !part.platformMessageId.trim(),
          );
        }
        pending.push(record.receipt, record.raw, record.parts);
      }
    },
    snapshot(): DeliveryPlacementEvidence {
      return Object.freeze({
        channels: Object.freeze([...channels]),
        targets: Object.freeze([...targets]),
        threads: Object.freeze([...threads]),
        invalid,
      });
    },
  };
}

export function captureDeliveryPlacementEvidence(
  result: OutboundDeliveryResult,
): DeliveryPlacementEvidence {
  const recorder = createDeliveryPlacementEvidenceRecorder();
  recorder.observe(result);
  return recorder.snapshot();
}
