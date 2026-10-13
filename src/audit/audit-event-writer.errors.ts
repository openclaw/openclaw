import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { redactSensitiveText } from "../logging/redact.js";
import type { AuditWriterRequest } from "./audit-event-writer.types.js";

export function formatAuditWriterError(error: unknown): string {
  return truncateUtf16Safe(
    redactSensitiveText(error instanceof Error ? error.message : String(error), { mode: "tools" }),
    512,
  );
}

function executionIdentityFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("audit identity key is missing") ||
    message.includes("audit identity key is corrupt")
  ) {
    return "audit execution identity key unavailable";
  }
  if (message.includes("execution identity context conflict")) {
    return "audit execution identity context conflict";
  }
  if (message.includes("execution identity recovery evidence unavailable")) {
    return "audit execution identity recovery evidence unavailable";
  }
  if (
    message.includes("admission envelope") ||
    message.includes("admission work") ||
    message.includes("admission token")
  ) {
    return "audit execution identity envelope rejected";
  }
  return "audit execution identity persistence failed";
}

export function formatAuditWriterRequestError(request: AuditWriterRequest, error: unknown): string {
  if (request.type === "record-execution-identity") {
    return executionIdentityFailureMessage(error);
  }
  if (
    request.type === "record-execution-decision" ||
    request.type === "record-execution-decision-work"
  ) {
    return "audit execution decision rejected";
  }
  return formatAuditWriterError(error);
}
