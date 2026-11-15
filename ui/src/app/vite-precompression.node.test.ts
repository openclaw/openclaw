// @vitest-environment node
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { gzip as canonicalGzip } from "libdeflate";
import { gzip } from "pako";
import { expect, it } from "vitest";
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
