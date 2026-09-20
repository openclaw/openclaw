// @vitest-environment node
import { gunzipSync } from "node:zlib";
import { gzip } from "pako";
import { expect, it } from "vitest";
import { createControlUiPrecompressedAssetVariants } from "../../vite.config.ts";

it("ships smaller deflate blocks without changing the decoded JavaScript", () => {
  const source = Array.from(
    { length: 3000 },
    (_, index) =>
      `const value${index}={id:${index % 997},label:"component-${(index * 7919) % 13007}",enabled:${index % 2 === 0}};\n`,
  ).join("");
  const variants = createControlUiPrecompressedAssetVariants("assets/app.js", source);
  const compressed = variants.find((variant) => variant.fileName.endsWith(".gz"))!.source;
  const previous = gzip(source, { level: 9, legacyHash: true });

  expect(compressed.byteLength).toBeLessThan(previous.byteLength);
  expect(gunzipSync(compressed)).toEqual(Buffer.from(source));
  expect(createControlUiPrecompressedAssetVariants("assets/app.js", source)).toEqual(variants);
});
