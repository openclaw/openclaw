/**
 * Extracts a phone number from the top of a Telegram message text.
 * Assumes the phone number is the first non-empty line, formatted as a sequence of digits (optionally with +, -, spaces).
 * Returns { phoneNumber, restOfMessage }
 */
export function extractPhoneNumberFromTelegram(text: string): {
  phoneNumber: string | null;
  restOfMessage: string;
} {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  let phoneNumber: string | null = null;
  let firstNonEmptyIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) {
      firstNonEmptyIdx = i;
      // Simple phone number pattern: starts with + or digit, contains at least 7 digits
      if (/^(\+?\d[\d\s-]{6,})$/.test(lines[i])) {
        phoneNumber = lines[i].replace(/[^\d+]/g, "");
      }
      break;
    }
  }
  const restOfMessage =
    firstNonEmptyIdx >= 0
      ? lines
          .slice(firstNonEmptyIdx + 1)
          .join("\n")
          .trim()
      : text;
  return { phoneNumber, restOfMessage };
}
