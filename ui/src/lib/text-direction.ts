const RTL_CHAR_REGEX =
  /\p{Script=Hebrew}|\p{Script=Arabic}|\p{Script=Syriac}|\p{Script=Thaana}|\p{Script=Nko}|\p{Script=Samaritan}|\p{Script=Mandaic}|\p{Script=Adlam}|\p{Script=Phoenician}|\p{Script=Lydian}/u;

const DECIMAL_DIGIT_REGEX = /\p{Nd}/u;

// Explicit bidi controls outrank the first strong character (UAX #9).
// Check them before the neutral-format scan, which would otherwise skip them.
const RTL_CONTROL_REGEX = /[\u061C\u200F\u202B\u202E\u2067]/u;
const LTR_CONTROL_REGEX = /[\u200E\u202A\u202D\u2066]/u;

// Skip Markdown punctuation and neutral formatting such as PDF, PDI, FSI, ZWJ,
// and BOM; otherwise an invisible non-RTL character would force the text to LTR.
const NEUTRAL_PREFIX_REGEX = /[\s\p{P}\p{S}\p{Cf}]/u;

/** Detect text direction from the first significant character. */
export function detectTextDirection(text: string | null): "rtl" | "ltr" {
  if (!text) {
    return "ltr";
  }
  let numericDirection: "rtl" | "ltr" | undefined;
  for (const char of text) {
    if (RTL_CONTROL_REGEX.test(char)) {
      return "rtl";
    }
    if (LTR_CONTROL_REGEX.test(char)) {
      return "ltr";
    }
    if (NEUTRAL_PREFIX_REGEX.test(char)) {
      continue;
    }
    const direction = RTL_CHAR_REGEX.test(char) ? "rtl" : "ltr";
    // Decimal digits are weak; keep their direction only for numeric-only text.
    if (DECIMAL_DIGIT_REGEX.test(char)) {
      numericDirection ??= direction;
      continue;
    }
    return direction;
  }
  return numericDirection ?? "ltr";
}
