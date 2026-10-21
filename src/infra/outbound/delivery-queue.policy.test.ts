import { describe, expect, it } from "vitest";
import { isProvenDeliveryNotSentError } from "../delivery-recovery.shared.js";
import { recordRetryAttemptErrors } from "../retry-attempt-errors.js";
import { findTerminalBatchRejection } from "./deliver-queue-state.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";

describe("delivery-queue policy", () => {
  describe("isProvenDeliveryNotSentError", () => {
    const createMarker = () =>
      new PlatformMessageNotDispatchedError("upload stopped before finalization", {
        cause: new Error("request timed out"),
      });

    it("rejects a platform error that copies only the marker code", () => {
      const forged = Object.assign(new Error("remote platform failure"), {
        code: createMarker().code,
      });
      expect(isProvenDeliveryNotSentError(forged)).toBe(false);
    });

    it("rejects a marked aggregate with a null branch", () => {
      expect(isProvenDeliveryNotSentError(new AggregateError([createMarker(), null]))).toBe(false);
    });

    it("rejects a marker that follows an ambiguous retry attempt", () => {
      const marker = createMarker();
      recordRetryAttemptErrors(marker, [new Error("connection reset after write"), marker]);
      expect(isProvenDeliveryNotSentError(marker)).toBe(false);
    });

    it("retires an all-refused batch only with a permanent no-send marker", () => {
      const marker = new PlatformMessageNotDispatchedError(
        "LINE refused the batch and every individual message",
        {
          cause: new AggregateError(
            [new Error("batch HTTP 400"), new Error("singleton HTTP 400")],
            "LINE batch and singleton recovery requests failed",
          ),
          retryable: false,
        },
      );

      expect(isProvenDeliveryNotSentError(marker)).toBe(true);
      expect(findTerminalBatchRejection([marker])).toBe(marker);
    });

    it("does not retire a batch when any recovery branch is ambiguous", () => {
      const marker = new PlatformMessageNotDispatchedError("singleton was refused", {
        cause: new Error("singleton HTTP 400"),
        retryable: false,
      });
      const ambiguous = Object.assign(new Error("connection reset after write"), {
        code: "ECONNRESET",
      });
      const aggregate = new AggregateError(
        [new Error("batch HTTP 400"), marker, ambiguous],
        "LINE batch and singleton recovery requests failed",
      );

      expect(isProvenDeliveryNotSentError(aggregate)).toBe(false);
      expect(findTerminalBatchRejection([aggregate])).toBeUndefined();
    });
  });
});
