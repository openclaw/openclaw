/**
 * Mask an API key for safe display in user-facing interfaces.
 *
 * Only the key prefix (up to the first separator or first 4 chars) is shown,
 * followed by `***`.  This is enough to identify *which* key is active without
 * exposing the secret portion.
 *
 * Previously, this function showed the first 8 and last 8 characters (or the
 * full key when <= 16 chars), which leaked enough material for key
 * identification or partial brute-force — see openclaw/openclaw#23976.
 */
export const maskApiKey = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "missing";
  }
  const prefix = extractKeyPrefix(trimmed);
  return `${prefix}***`;
};

/**
 * Extract the human-readable prefix of an API key.
 *
 * Many providers use a structured prefix (e.g. `sk-or-`, `sk-cp-`, `sk-ant-`,
 * `gsk_`).  We walk forward through separator characters (`-`, `_`) and keep
 * up to 2 separator-delimited segments, capping at 8 characters total.
 *
 * If no separator is found within the first 8 characters, the first 4
 * characters are returned as a safe fallback.
 */
function extractKeyPrefix(key: string): string {
  const maxPrefixLen = 8;
  let separatorCount = 0;
  let lastSepIndex = -1;

  for (let i = 0; i < Math.min(key.length, maxPrefixLen); i++) {
    if (key[i] === "-" || key[i] === "_") {
      separatorCount++;
      lastSepIndex = i;
      // After 2 separators we have enough context (e.g. "sk-or-").
      if (separatorCount >= 2) {
        return key.slice(0, i + 1);
      }
    }
  }

  // One separator found (e.g. "gsk_") — include it.
  if (lastSepIndex >= 0) {
    return key.slice(0, lastSepIndex + 1);
  }

  // No separator — show first 4 chars.
  return key.slice(0, Math.min(4, key.length));
}
