import { createHash } from "node:crypto";
import { normalizeNullableString as nonEmptyStringField } from "@openclaw/normalization-core/string-coerce";
import { stableStringify } from "./stable-stringify.js";

function digestStable(value: unknown): string {
  const serialized = stableStringify(value);
  return createHash("sha256").update(serialized).digest("hex");
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeExitSignal(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return null;
}

function normalizeFailureReason(value: unknown): string {
  const text = nonEmptyStringField(value);
  if (!text) {
    return "";
  }
  const summary = text.split("\n", 1)[0] ?? "";
  return summary
    .replace(/id=\S+/gi, "id=X")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "U")
    .replace(/\b0x[0-9a-f]+\b/gi, "H")
    .replace(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, "H")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function hashStableExecFailure(status: string, details: Record<string, unknown>): string {
  const exitCode = typeof details.exitCode === "number" ? details.exitCode : null;
  const exitSignal = normalizeExitSignal(details.exitSignal);
  const hasStructuredExitIdentity = exitCode !== null || exitSignal !== null;
  return digestStable({
    status,
    exitCode,
    timedOut: details.timedOut === true,
    exitSignal,
    failureKind: stringField(details.failureKind),
    ...(status === "failed" && !hasStructuredExitIdentity
      ? { reason: normalizeFailureReason(details.failureReason ?? details.aggregated) }
      : {}),
  });
}
