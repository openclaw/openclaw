import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

// Shared sanitization for doctor/lint/repair errors shown in terminal output.
const ERR_MESSAGE_MAX_LEN = 256;

/** Removes control characters and caps error messages before doctor prints them. */
export function scrubDoctorErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const stripped = raw
    // oxlint-disable-next-line eslint/no-control-regex -- Doctor intentionally removes C0/DEL controls while retaining whitespace below.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\t\n\r]/gu, " ")
    .replace(/ {2,}/gu, " ")
    .trim();
  if (stripped.length <= ERR_MESSAGE_MAX_LEN) {
    return stripped;
  }
  return `${truncateUtf16Safe(stripped, ERR_MESSAGE_MAX_LEN - 3)}...`;
}
