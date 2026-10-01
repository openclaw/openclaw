import type {
  OpenClawStateReadOutcome,
  OpenClawStateReadPhase,
} from "./openclaw-state-read.types.js";

export type OpenClawStateReadReceipt = { phase: OpenClawStateReadPhase };

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
