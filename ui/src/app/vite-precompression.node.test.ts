// @vitest-environment node
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { gzip as canonicalGzip } from "libdeflate";
import { gzip } from "pako";
import { expect, it } from "vitest";
import {
  createControlUiBudgetNormalizer,
  measureControlUiBudgetAsset,
} from "../../config/control-ui-asset-compression.ts";
import { createControlUiPrecompressedAssetVariants } from "../../vite.config.ts";

it("keeps boot Brotli savings and cheaper deferred compression without changing JavaScript", async () => {
  const source = Array.from(
    { length: 3000 },
    (_, index) =>
      `const value${index}={id:${index % 997},label:"component-${(index * 7919) % 13007}",enabled:${index % 2 === 0}};\n`,
  ).join("");
  const variants = await createControlUiPrecompressedAssetVariants(
    "assets/app.js",
    source,
    new Set(["assets/app.js"]),
  );
  const compressed = variants.find((variant) => variant.fileName.endsWith(".gz"))!.source;
  const previous = gzip(source, { level: 9, legacyHash: true, memLevel: 6 });

  expect(compressed.byteLength).toBeLessThan(previous.byteLength);
  expect(gunzipSync(compressed)).toEqual(Buffer.from(source));
  const bootBrotli = variants.find((variant) => variant.fileName.endsWith(".br"))!.source;
  const deferred = await createControlUiPrecompressedAssetVariants("assets/app.js", source);
  const deferredGzip = deferred.find((variant) => variant.fileName.endsWith(".gz"))!.source;
  expect(compressed.byteLength).toBeLessThanOrEqual(deferredGzip.byteLength);
  expect(gunzipSync(deferredGzip)).toEqual(Buffer.from(source));
  expect(deferredGzip).toEqual(Buffer.from(canonicalGzip(Buffer.from(source), 12)));
  const unrelatedBoot = await createControlUiPrecompressedAssetVariants(
    "assets/app.js",
    source,
    new Set(["assets/unrelated.js"]),
  );
  expect(unrelatedBoot.find((variant) => variant.fileName.endsWith(".gz"))!.source).toEqual(
    deferredGzip,
  );
  const deferredBrotli = deferred.find((variant) => variant.fileName.endsWith(".br"))!.source;
  expect(bootBrotli.byteLength).toBeLessThan(deferredBrotli.byteLength);
  expect(brotliDecompressSync(bootBrotli)).toEqual(Buffer.from(source));
  expect(brotliDecompressSync(deferredBrotli)).toEqual(Buffer.from(source));
});

it("measures normalized assets with the gzip level selection the build ships", async () => {
  const file = "assets/index-AbCd1234.js";
  const source =
    `import"./runtime-EfGh5678.js";` +
    Array.from(
      { length: 2000 },
      (_, index) =>
        `l${(index * 7) % 251}:${"abcdefghij".slice(index % 7, (index % 7) + 3)}${(index * 7) % 13};`,
    ).join("");
  const normalize = createControlUiBudgetNormalizer(["index-AbCd1234.js", "runtime-EfGh5678.js"]);
  const normalized = Buffer.from(normalize(source));
  expect(normalized.toString()).not.toBe(source);
  // The fixture only proves parity when a lower boot level beats level 12.
  expect(canonicalGzip(normalized, 10).byteLength).toBeLessThan(
    canonicalGzip(normalized, 12).byteLength,
  );
  const shippedGzipBytes = async (bootAssets?: Set<string>) =>
    (await createControlUiPrecompressedAssetVariants(file, normalized, bootAssets)).find(
      (variant) => variant.fileName.endsWith(".gz"),
    )!.source.byteLength;
  const measure = (eligible: boolean, boot: boolean) =>
    measureControlUiBudgetAsset(
      source,
      normalize,
      { gzipBytes: 1, brotliBytes: 1 },
      { eligible, boot },
    ).gzipBytes;

  expect(measure(true, true)).toBe(await shippedGzipBytes(new Set([file])));
  expect(measure(true, false)).toBe(await shippedGzipBytes());
  expect(measure(false, false)).toBe(normalized.byteLength);
});
