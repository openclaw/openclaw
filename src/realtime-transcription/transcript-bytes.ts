/** Bytes added by a delta, including a surrogate pair split across frames. */
export function measureTranscriptDeltaBytes(previous: string, delta: string): number {
  const previousCodeUnit = previous.charCodeAt(previous.length - 1);
  const nextCodeUnit = delta.charCodeAt(0);
  const completesSurrogatePair =
    previousCodeUnit >= 0xd800 &&
    previousCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff;
  // Two replacement characters occupy six bytes; the joined code point occupies four.
  return Buffer.byteLength(delta, "utf8") - (completesSurrogatePair ? 2 : 0);
}
