// Reconciles adapter progress results with hook-bearing final delivery results.
import { resolveReceiptSourceId } from "../../channels/message/receipt.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";

function normalizePlatformIds(values: Array<string | undefined>): string[] {
  return values
    .map((value) => value?.trim())
    .filter((id): id is string => Boolean(id && id !== "unknown" && id !== "suppressed"));
}

export function createDeliveryResultRecorder(params: {
  results: OutboundDeliveryResult[];
  onDeliveryResult?: (result: OutboundDeliveryResult) => Promise<void> | void;
}) {
  const results = params.results;
  const reportedResults = new Map<number, string>();
  let suppressionReason: "adapter_returned_no_send" | "adapter_returned_no_identity" | undefined;
  const observeDeliveryResult = (delivery: OutboundDeliveryResult): boolean => {
    if (resolveReceiptSourceId(delivery) !== undefined) {
      return true;
    }
    // One ambiguous completion prevents the payload from claiming that every
    // transport deliberately declined to send, regardless of callback order.
    suppressionReason =
      delivery.outcome === "not_sent"
        ? (suppressionReason ?? "adapter_returned_no_send")
        : "adapter_returned_no_identity";
    return false;
  };
  const resultIdentityKey = (delivery: OutboundDeliveryResult): string =>
    JSON.stringify([
      delivery.channel,
      delivery.messageId,
      delivery.target,
      delivery.timestamp,
      delivery.toJid,
      delivery.pollId,
    ]);
  const resultPlatformIds = (
    delivery: OutboundDeliveryResult,
    options?: { receiptOnly?: boolean },
  ): Set<string> =>
    new Set(
      normalizePlatformIds([
        ...(options?.receiptOnly ? [] : [delivery.messageId]),
        delivery.receipt?.primaryPlatformMessageId,
        ...(delivery.receipt?.platformMessageIds ?? []),
        ...(delivery.receipt?.parts ?? []).map((part) => part.platformMessageId),
      ]),
    );
  const recordIdentifiedDeliveryResults = async (
    deliveries: readonly OutboundDeliveryResult[],
    options?: { finalResultIsLastReported?: boolean },
  ): Promise<boolean[]> => {
    if (deliveries.length === 0) {
      suppressionReason = "adapter_returned_no_identity";
    }
    try {
      const recorded: boolean[] = [];
      const availableReported = options?.finalResultIsLastReported
        ? new Map([...reportedResults].toReversed())
        : reportedResults;
      const takeReported = (
        matches: (resultIndex: number, identityKey: string) => boolean,
      ): number | undefined => {
        for (const [resultIndex, identityKey] of availableReported) {
          if (matches(resultIndex, identityKey)) {
            availableReported.delete(resultIndex);
            return resultIndex;
          }
        }
        return undefined;
      };
      const replacements = new Map<number, OutboundDeliveryResult | null>();
      const appendResults: OutboundDeliveryResult[] = [];
      for (const delivery of deliveries) {
        if (!observeDeliveryResult(delivery)) {
          recorded.push(false);
          continue;
        }
        const receiptPartIds = normalizePlatformIds(
          (delivery.receipt?.parts ?? []).map((part) => part.platformMessageId),
        );
        const receiptIds =
          receiptPartIds.length > 0
            ? receiptPartIds
            : [...resultPlatformIds(delivery, { receiptOnly: true })];
        let reportedIndex: number | undefined;
        for (const receiptId of receiptIds) {
          // One receipt part covers one progress result. Repeated parts preserve
          // aggregate multiplicity, while one constant platform ID cannot erase
          // other successful sends that the final receipt does not aggregate.
          const matchingIndex = takeReported((index) => {
            const result = results[index];
            return result?.channel === delivery.channel && resultPlatformIds(result).has(receiptId);
          });
          if (matchingIndex !== undefined) {
            replacements.set(matchingIndex, null);
            reportedIndex = Math.min(reportedIndex ?? matchingIndex, matchingIndex);
          }
        }
        if (reportedIndex === undefined) {
          const identityKey = resultIdentityKey(delivery);
          reportedIndex = takeReported((_index, reportedKey) => reportedKey === identityKey);
        }
        if (reportedIndex !== undefined) {
          // Replace all progress covered by an aggregate receipt with the final
          // hook-bearing object, avoiding duplicate receipt parts.
          replacements.set(reportedIndex, delivery);
        } else {
          appendResults.push(delivery);
        }
        recorded.push(true);
      }
      if (replacements.size > 0) {
        const reconciled = results.flatMap((result, index) => {
          const replacement = replacements.get(index);
          return replacement === null ? [] : [replacement ?? result];
        });
        results.splice(0, results.length, ...reconciled);
      }
      for (const delivery of appendResults) {
        results.push(delivery);
        await params.onDeliveryResult?.(delivery);
      }
      return recorded;
    } finally {
      // Progress matching is scoped to exactly one adapter invocation. IDs such
      // as LINE's constant "push" value can legitimately repeat later.
      reportedResults.clear();
    }
  };
  return {
    recordIdentifiedDeliveryResult: async (delivery: OutboundDeliveryResult): Promise<boolean> => {
      const [recorded] = await recordIdentifiedDeliveryResults([delivery], {
        finalResultIsLastReported: true,
      });
      return recorded ?? false;
    },
    recordIdentifiedDeliveryResults,
    reportIdentifiedDeliveryResult: async (delivery: OutboundDeliveryResult): Promise<void> => {
      if (!observeDeliveryResult(delivery)) {
        return;
      }
      const resultIndex = results.length;
      results.push(delivery);
      reportedResults.set(resultIndex, resultIdentityKey(delivery));
      // Persist concrete platform evidence before pinning, hooks, mirroring, or
      // another send can fail or the process can stop.
      await params.onDeliveryResult?.(delivery);
    },
    getSuppressionReason: () => suppressionReason,
    resetPayloadResults: () => {
      reportedResults.clear();
      suppressionReason = undefined;
    },
  };
}
