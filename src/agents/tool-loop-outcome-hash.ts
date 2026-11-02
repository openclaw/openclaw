import { sha256StableValue } from "@openclaw/normalization-core/node-crypto";

export function digestToolOutcome(value: unknown): string {
  // Canonical IDs retain valid envelope syntax; malformed markers and JSON field
  // boundaries remain meaningful. Literal/copied envelopes share this syntax rule;
  // it grants no trust and never changes arguments or delivered content.
  const canonicalMarkerId = "0000000000000000";
  return sha256StableValue(value, (text) =>
    text.replace(
      /(<<<EXTERNAL_UNTRUSTED_CONTENT id=(\\*)")([a-f0-9]{16})(\2">>>(?:(?!<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT)[\s\S])*<<<END_EXTERNAL_UNTRUSTED_CONTENT id=\2")\3(\2">>>)/g,
      // Repeated JSON encoding produces 2^n - 1 backslashes before marker quotes.
      (match, start: string, escapes: string, _id: string, middle: string, end: string) =>
        (escapes.length & (escapes.length + 1)) !== 0 ||
        [...middle.matchAll(/(?<!\\)\\*"/g)].some(
          (quote) => quote[0].length % (escapes.length + 1) !== 0,
        )
          ? match
          : start + canonicalMarkerId + middle + canonicalMarkerId + end,
    ),
  ).digest;
}
