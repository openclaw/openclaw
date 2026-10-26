import zlib from "node:zlib";

export type ZstdCodec = {
  compress: (data: Uint8Array, level?: number, checksum?: boolean) => Buffer;
  decompress: (data: Uint8Array, maxOutputLength?: number) => Buffer;
};

let resolvedCodec: ZstdCodec | undefined;

/** Share one codec instance across process-local readers and writers. */
export function resolveZstdCodec(): ZstdCodec {
  return (resolvedCodec ??= {
    compress: (data, level, checksum) => {
      if (level === undefined && checksum === undefined) {
        return zlib.zstdCompressSync(data);
      }
      return zlib.zstdCompressSync(data, {
        params: {
          ...(level === undefined ? {} : { [zlib.constants.ZSTD_c_compressionLevel]: level }),
          ...(checksum === undefined ? {} : { [zlib.constants.ZSTD_c_checksumFlag]: checksum }),
        },
      });
    },
    decompress: (data, maxOutputLength) =>
      zlib.zstdDecompressSync(
        data,
        maxOutputLength === undefined ? undefined : { maxOutputLength },
      ),
  });
}
