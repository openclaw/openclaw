import { resolveZstdCodec } from "../../infra/zstd-codec.js";

const zstdCodec = resolveZstdCodec();

export function decodeSessionArchiveBytes(
  bytes: Uint8Array,
  compressed: boolean,
  expectedUtf8Bytes?: number,
): string {
  if (!compressed) {
    return Buffer.from(bytes).toString("utf8");
  }
  if (!zstdCodec) {
    throw new Error("Cannot decode compressed transcript archive: this runtime lacks zstd support");
  }
  return zstdCodec
    .decompress(Buffer.from(bytes), expectedUtf8Bytes ?? bytes.byteLength + 1024 * 1024)
    .toString("utf8");
}
