// @vitest-environment node
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
  gunzipSync,
} from "node:zlib";
import { gzip } from "pako";
import { expect, it } from "vitest";
import { createControlUiPrecompressedAssetVariants } from "../../vite.config.ts";

it.each([
  "",
  "export{};",
  'import{r as e,t}from"./cron-page-DprkJtRo.js";e();export{t as CronPage};',
])("omits compressed variants that cannot reduce %j", async (source) => {
  expect(await createControlUiPrecompressedAssetVariants("assets/tiny.js", source)).toEqual([]);
});

it("keeps a beneficial encoding when its sibling is larger than the original", async () => {
  const source = "a".repeat(20);
  const variants = await createControlUiPrecompressedAssetVariants("assets/small.txt", source);

  expect(variants.map((variant) => variant.fileName)).toEqual(["assets/small.txt.br"]);
  expect(brotliDecompressSync(variants[0]!.source)).toEqual(Buffer.from(source));
});

it("ships smaller deflate blocks without changing the decoded JavaScript or Brotli bytes", async () => {
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
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 },
    }),
  );
});
