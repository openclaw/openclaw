/** Masks credential-like values for diagnostics while preserving enough prefix/suffix to identify them. */
export const maskApiKey = (value: string): string => {
  const trimmed = stripControlCharacters(value).trim();
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

function stripControlCharacters(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    const isControl = (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
    if (!isControl) {
      out += char;
    }
  }
  return out;
}
