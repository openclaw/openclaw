export class Utf8InputError extends Error {}

function strictUtf8Decoder(sourceLabel: string) {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return (bytes?: Uint8Array, stream = false): string => {
    try {
      return decoder.decode(bytes, { stream });
    } catch (error) {
      throw new Utf8InputError(`${sourceLabel} must be valid UTF-8.`, { cause: error });
    }
  };
}

export function decodeUtf8Input(bytes: Uint8Array, sourceLabel: string): string {
  return strictUtf8Decoder(sourceLabel)(bytes);
}

export async function* decodeUtf8Chunks(
  chunks: AsyncIterable<Uint8Array>,
  sourceLabel: string,
): AsyncGenerator<string> {
  const decode = strictUtf8Decoder(sourceLabel);
  for await (const chunk of chunks) {
    yield decode(chunk, true);
  }
  yield decode();
}
