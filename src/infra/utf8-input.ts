export function decodeUtf8Input(bytes: Uint8Array, sourceLabel: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${sourceLabel} must be valid UTF-8.`, { cause: error });
  }
}
