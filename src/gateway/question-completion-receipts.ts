import { randomUUID } from "node:crypto";
import { hasSessionQuestionCustodyRetiredError } from "../config/sessions/session-questions-custody-error.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import type { QuestionReceiptOwed } from "./question-continuation.js";

/** Retries only decided terminal receipts, under the original Gateway owner. */
export function createQuestionCompletionReceipts(params: {
  scheduler: GatewayScheduler;
  warn: (message: string) => void;
  onSettled?: (receipt: QuestionReceiptOwed) => Promise<void>;
}) {
  const scheduler = params.scheduler.scope();
  const prefix = `question-completion-receipts:${randomUUID()}`;
  const pending = new Map<string, QuestionReceiptOwed>();
  const offer = (
    receipt: QuestionReceiptOwed,
    onSettled?: () => Promise<void>,
    onRetired?: () => void,
  ) => {
    if (scheduler.signal.aborted) {
      return;
    }
    const key = JSON.stringify([receipt.questionId, receipt.runId]);
    if (pending.has(key)) {
      return;
    }
    pending.set(key, receipt);
    let delayMs = 1_000;
    const schedule = () => {
      if (scheduler.signal.aborted) {
        return;
      }
      scheduler.schedule({
        id: `${prefix}:${key}`,
        delayMs,
        run: async () => {
          if (scheduler.signal.aborted) {
            return;
          }
          try {
            await receipt.repair();
          } catch (error) {
            if (hasSessionQuestionCustodyRetiredError(error)) {
              pending.delete(key);
              if (!scheduler.signal.aborted) {
                try {
                  onRetired?.();
                } catch (reportError) {
                  try {
                    params.warn(
                      `Terminal question receipt retirement failed: ${String(reportError)}`,
                    );
                  } catch {}
                }
              }
              return;
            }
            if (scheduler.signal.aborted) {
              return;
            }
            try {
              params.warn(`Terminal question receipt repair failed: ${String(error)}`);
            } catch {}
            delayMs = Math.min(delayMs * 2, 30_000);
            schedule();
            return;
          }
          pending.delete(key);
          if (!scheduler.signal.aborted) {
            try {
              await (onSettled ? onSettled() : params.onSettled?.(receipt));
            } catch (error) {
              try {
                params.warn(`Terminal question receipt notification failed: ${String(error)}`);
              } catch {}
            }
          }
        },
      });
    };
    schedule();
  };
  return {
    offer,
    beginClose: () => {
      scheduler.beginClose();
      pending.clear();
    },
    stop: scheduler.stop,
  };
}
