import type {
  OpenClawStateReadOptions,
  OpenClawStateReadOutcome,
  OpenClawStateReadPhase,
} from "./openclaw-state-read.types.js";

export type OpenClawStateReadReceipt = { phase: OpenClawStateReadPhase };

export function mapOpenClawStateReadError<T>(
  mapError: OpenClawStateReadOptions["mapError"],
  read: (receipt: OpenClawStateReadReceipt) => Promise<T>,
): Promise<T> {
  const receipt: OpenClawStateReadReceipt = { phase: "before-read" };
  try {
    const result = read(receipt);
    return mapError
      ? result.catch((error: unknown) => {
          throw mapError(error, receipt.phase);
        })
      : result;
  } catch (error) {
    throw mapError ? mapError(error, receipt.phase) : error;
  }
}

export function observeReadOutcome(
  receipt: OpenClawStateReadReceipt,
  outcome: OpenClawStateReadOutcome | undefined,
): void {
  if (!outcome) {
    return;
  }
  const admitted =
    "error" in outcome
      ? outcome.sourceAdmitted
      : outcome.value.type === "admit"
        ? undefined
        : outcome.value.sourceAdmitted;
  if (admitted === true) {
    receipt.phase = "read";
  } else if (admitted === false && receipt.phase !== "read") {
    receipt.phase = "before-read";
  }
}
