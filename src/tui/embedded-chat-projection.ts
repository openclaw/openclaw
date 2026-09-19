import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";

export function payloadText(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => {
      const payload = asOptionalObjectRecord(part);
      return typeof payload?.text === "string" ? payload.text.trim() : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function resolveDeltaPayload(text: string, previousText: string | undefined) {
  if (previousText === undefined) {
    return { deltaText: text };
  }
  if (!text.startsWith(previousText)) {
    return { deltaText: text, replace: true as const };
  }
  return { deltaText: text.slice(previousText.length) };
}
