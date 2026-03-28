/**
 * Produce a safe display representation of an API key for logs and UI.
 *
 * Security invariants:
 *  - NEVER returns the full key, even for short inputs.
 *  - The number of revealed characters scales sub-linearly with key length
 *    so that short keys (< 7 chars) still expose at most 2 characters total.
 *  - The ellipsis length is fixed ("...") regardless of the hidden portion
 *    to prevent length-oracle attacks (an attacker cannot infer key length
 *    from the masked output).
 *
 * Masking table:
 *  | Length  | Prefix | Suffix | Example           |
 *  |---------|--------|--------|-------------------|
 *  | 0       | —      | —      | "missing"          |
 *  | 1–6     | 1 char | 1 char | "a...z"            |
 *  | 7–16    | 2 char | 2 char | "ab...yz"          |
 *  | 17+     | 8 char | 8 char | "12345678...abcdefgh" |
 */
export const maskApiKey = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "missing";
  }
  if (trimmed.length <= 6) {
    return `${trimmed.slice(0, 1)}...${trimmed.slice(-1)}`;
  }
  if (trimmed.length <= 16) {
    return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-8)}`;
};
