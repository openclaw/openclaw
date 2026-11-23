import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const ERR_MESSAGE_MAX_LEN = 256;

// Wrapped causes carry the specific refusal (for example which consent fact is missing);
// printing only the outer message leaves every such failure looking identical.
function describeDoctorError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  let text = err.message;
  const seen = new Set<Error>([err]);
  for (let cause = err.cause; cause instanceof Error && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    if (!text.includes(cause.message)) {
      text += ` Cause: ${cause.message}`;
    }
  }
  return text;
}

/** Removes control characters and caps error messages before doctor prints them. */
export function scrubDoctorErrorMessage(err: unknown): string {
  const raw = describeDoctorError(err);
  let stripped = "";
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      // Whitespace controls become spaces so multi-line errors don't glue words together.
      stripped += " ";
    } else if (code > 0x1f && code !== 0x7f) {
      stripped += raw.charAt(index);
    }
  }
  stripped = stripped.replace(/ {2,}/gu, " ").trim();
  if (stripped.length <= ERR_MESSAGE_MAX_LEN) {
    return stripped;
  }
  return `${truncateUtf16Safe(stripped, ERR_MESSAGE_MAX_LEN - 3)}...`;
}
