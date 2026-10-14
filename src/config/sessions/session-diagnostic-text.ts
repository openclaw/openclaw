import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const MAX_SESSION_DIAGNOSTIC_TEXT_CHARS = 140;

/** Bound diagnostic text before it crosses a worker or logging boundary. */
export function boundSessionDiagnosticText(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_SESSION_DIAGNOSTIC_TEXT_CHARS
    ? `${truncateUtf16Safe(oneLine, MAX_SESSION_DIAGNOSTIC_TEXT_CHARS - 3)}...`
    : oneLine;
}
