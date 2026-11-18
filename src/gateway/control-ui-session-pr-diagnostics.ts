import { channel } from "node:diagnostics_channel";

const diagnostics = channel("openclaw.gateway.session-pr");
let receiptReadSequence = 0;

type ReceiptDiagnosticDetails = {
  receiptProducerReadId?: number;
  receiptProducerPhase?: string;
  receiptSettled?: boolean;
};
export type SessionPrReceiptDiagnostic = {
  readId: number;
  record(phase: string, details?: ReceiptDiagnosticDetails): void;
};

/** Temporary diagnostic overlay: opt-in, payload-free, one receipt read only. */
export function createSessionPrReceiptDiagnostic(target: {
  params: { sessionKey: string };
  taskReceiptsOnly?: boolean;
}): SessionPrReceiptDiagnostic | undefined {
  if (!diagnostics.hasSubscribers) {
    return undefined;
  }
  const readId = ++receiptReadSequence;
  const started = performance.now();
  return {
    readId,
    record(phase, details) {
      recordSessionPrDiagnostic("receipt-" + phase, target, {
        receiptReadId: readId,
        elapsedMs: performance.now() - started,
        ...details,
      });
    },
  };
}

/** Opt-in phase facts only: no credentials, repository paths, or PR content. */
export function recordSessionPrDiagnostic(
  phase: string,
  target?: { params: { sessionKey: string }; taskReceiptsOnly?: boolean },
  details?: ReceiptDiagnosticDetails & {
    count?: number;
    current?: boolean;
    receiptReadId?: number;
    elapsedMs?: number;
  },
): void {
  if (diagnostics.hasSubscribers) {
    diagnostics.publish({
      phase,
      sessionKey: target?.params.sessionKey,
      receiptsOnly: target?.taskReceiptsOnly === true,
      ...details,
    });
  }
}
