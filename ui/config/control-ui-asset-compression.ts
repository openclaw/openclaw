import { brotliCompressSync, constants } from "node:zlib";
import { gzip } from "libdeflate";

// Deferred tiny chunks remain identity responses to bound installed sidecar count.
export function shouldPrecompressControlUiAsset(file: string, bytes: number, boot: boolean) {
  return bytes >= 16 * 1024 || file.toLowerCase().endsWith(".css") || boot;
}

/** Keep asset identities, but remove generated hashes from budget compression. */
export function createControlUiBudgetNormalizer(assetNames: Iterable<string>) {
  const names = new Map<string, string>();
  for (const name of assetNames) {
    const normalized = name.replace(/-[\w-]{8}(\.[\w]+(?:\.map)?)$/u, "-00000000$1");
    if (normalized !== name) {
      names.set(name, normalized);
    }
  }
  return (source: string) => source.replace(/[\w.-]+/gu, (name) => names.get(name) ?? name);
}

export function measureControlUiBudgetAsset(
  source: string,
  normalize: (source: string) => string,
  served: { gzipBytes: number; brotliBytes: number },
  compression: { eligible: boolean; boot: boolean },
) {
  const normalized = normalize(source);
  // Unchanged input already has the canonical build's compressed bytes.
  if (normalized === source) {
    return { gzipBytes: served.gzipBytes, brotliBytes: served.brotliBytes };
  }
  const body = Buffer.from(normalized);
  if (!compression.eligible) {
    return { gzipBytes: body.byteLength, brotliBytes: body.byteLength };
  }
  return {
    gzipBytes: Math.min(body.byteLength, gzip(body, 12).byteLength),
    brotliBytes: Math.min(
      body.byteLength,
      brotliCompressSync(body, {
        params: { [constants.BROTLI_PARAM_QUALITY]: compression.boot ? 11 : 10 },
      }).byteLength,
    ),
  };
}
