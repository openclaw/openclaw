import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

export function stripInvalidatedTranscriptUserMetadata(params: {
  fieldKey: string | undefined;
  location: string;
  source: Record<string, unknown>;
  redacted: Record<string, unknown>;
}): Record<string, unknown> {
  const { fieldKey, location, source, redacted } = params;
  // Redacted source facts cannot retain sender or UTF-16 mention bindings.
  if (fieldKey === "__openclaw") {
    if (
      redacted.senderIdentity !== source.senderIdentity ||
      redacted.senderId !== source.senderId
    ) {
      delete redacted.senderIdentity;
    }
    if (redacted.humanMentions !== source.humanMentions) {
      delete redacted.humanMentions;
    }
  }
  if (location === "root" && source.role === "user" && redacted.content !== source.content) {
    const metadata = asOptionalRecord(redacted["__openclaw"]);
    if (metadata?.humanMentions !== undefined) {
      const retained = { ...metadata };
      delete retained.humanMentions;
      redacted["__openclaw"] = retained;
    }
  }
  return redacted;
}
