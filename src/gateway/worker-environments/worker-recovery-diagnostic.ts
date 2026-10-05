import { createHash } from "node:crypto";

export function collectFailureDiagnostic(
  origin: "failed-placement" | "unused-prepared-worker",
  failure: string | null,
  collectedAtMs: number,
) {
  return {
    origin,
    cause: "unverified" as const,
    collectedAtMs,
    failureHash: failure ? createHash("sha256").update(failure).digest("hex") : null,
  };
}
