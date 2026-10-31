export class Utf8InputError extends Error {
  readonly code = "ERR_INVALID_UTF8";
}

const createUtf8Decoder = () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const inputDecoder = createUtf8Decoder();

function decode(
  decoder: TextDecoder,
  bytes: Uint8Array | undefined,
  sourceLabel: string,
  stream = false,
): string {
  try {
    return decoder.decode(bytes, stream ? { stream: true } : undefined);
  } catch (error) {
    throw new Utf8InputError(`${sourceLabel} must be valid UTF-8.`, { cause: error });
  }
}

export function decodeUtf8Input(bytes: Uint8Array, sourceLabel: string): string {
  return decode(inputDecoder, bytes, sourceLabel);
}

export async function* decodeUtf8Chunks(
  chunks: AsyncIterable<Uint8Array>,
  sourceLabel: string,
): AsyncGenerator<string> {
  const decoder = createUtf8Decoder();
  for await (const chunk of chunks) {
    yield decode(decoder, chunk, sourceLabel, true);
  }
  yield decode(decoder, undefined, sourceLabel);
}
