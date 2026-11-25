import { normalizeGatewayOperatorRecoverySnapshot } from "../gateway/operator-run-recovery-source.codec.js";

/** Canonicalize the private native process grant with the existing bounded recovery codec. */
export function decodeCronStreamOperatorSource(value: unknown) {
  const snapshot = normalizeGatewayOperatorRecoverySnapshot(value);
  if (!snapshot) {
    throw new TypeError("Invalid native stream operator source; reauthorize the stream.");
  }
  return snapshot;
}
