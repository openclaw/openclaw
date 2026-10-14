import zlib from "node:zlib";

export type ZstdCodec = {
  compress: (data: Uint8Array, level?: number, checksum?: boolean) => Buffer;
  decompress: (data: Uint8Array, maxOutputLength?: number) => Buffer;
};

let resolvedCodec: ZstdCodec | null | undefined;

/** Resolve the process runtime once; persisted readers must reject unsupported compressed data. */
export function resolveZstdCodec(): ZstdCodec | null {
  if (resolvedCodec !== undefined) {
    return resolvedCodec;
  }
  if (
    typeof zlib.zstdCompressSync !== "function" ||
    typeof zlib.zstdDecompressSync !== "function"
  ) {
    resolvedCodec = null;
    return resolvedCodec;
  }
  const compress = zlib.zstdCompressSync.bind(zlib);
  const decompress = zlib.zstdDecompressSync.bind(zlib);
  resolvedCodec = {
    compress: (data, level, checksum) => {
      if (level === undefined && checksum === undefined) {
        return compress(data);
      }
      return compress(data, {
        params: {
          ...(level === undefined ? {} : { [zlib.constants.ZSTD_c_compressionLevel]: level }),
          ...(checksum === undefined ? {} : { [zlib.constants.ZSTD_c_checksumFlag]: checksum }),
        },
      });
    },
    decompress: (data, maxOutputLength) =>
      decompress(data, maxOutputLength === undefined ? undefined : { maxOutputLength }),
  };
  return resolvedCodec;
}
