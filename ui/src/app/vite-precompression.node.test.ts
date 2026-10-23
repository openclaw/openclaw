// @vitest-environment node
import { brotliCompressSync, constants as zlibConstants, gunzipSync } from "node:zlib";
import { gzip } from "pako";
import { expect, it } from "vitest";
import { createControlUiPrecompressedAssetVariants } from "../../vite.config.ts";

it("ships smaller deflate blocks and high-quality Brotli without changing decoded JavaScript", async () => {
  const source = Array.from(
    { length: 3000 },
    (_, index) =>
      `const value${index}={id:${index % 997},label:"component-${(index * 7919) % 13007}",enabled:${index % 2 === 0}};\n`,
  ).join("");
  const variants = await createControlUiPrecompressedAssetVariants("assets/app.js", source);
  const compressed = variants.find((variant) => variant.fileName.endsWith(".gz"))!.source;
  const previous = gzip(source, { level: 9, legacyHash: true });

  expect(compressed.byteLength).toBeLessThan(previous.byteLength);
  expect(gunzipSync(compressed)).toEqual(Buffer.from(source));
  expect(variants.find((variant) => variant.fileName.endsWith(".br"))!.source).toEqual(
    brotliCompressSync(Buffer.from(source), {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 10 },
    }),
  );
});
