import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";

export async function verifyGatewayServedControlUiBundle(httpUrl: string): Promise<{
  assetPath: string;
  assetSha256: string;
}> {
  const distRoot = path.resolve("dist/control-ui");
  const builtIndex = await readFile(path.join(distRoot, "index.html"), "utf8");
  const assetPath = builtIndex.match(/<script[^>]+src="\.\/(assets\/[^"]+\.js)"/u)?.[1];
  if (!assetPath) {
    throw new Error("built Control UI index has no JavaScript asset path");
  }
  const servedIndexResponse = await fetch(httpUrl);
  expect(servedIndexResponse.status).toBe(200);
  expect(await servedIndexResponse.text()).toContain(`src="/${assetPath}"`);
  const servedAssetResponse = await fetch(new URL(assetPath, httpUrl));
  expect(servedAssetResponse.status).toBe(200);
  const servedAsset = Buffer.from(await servedAssetResponse.arrayBuffer());
  const builtAsset = await readFile(path.join(distRoot, assetPath));
  const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const assetSha256 = hash(builtAsset);
  expect(hash(servedAsset)).toBe(assetSha256);
  return { assetPath, assetSha256 };
}
