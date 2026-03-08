import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, "../../dist/control-ui");
const assetsDir = path.join(distDir, "assets");

const budgets = {
  initialJsKb: Number(process.env.OPENCLAW_UI_BUDGET_INITIAL_JS_KB ?? 350),
  initialCssKb: Number(process.env.OPENCLAW_UI_BUDGET_INITIAL_CSS_KB ?? 70),
  asyncJsKb: Number(process.env.OPENCLAW_UI_BUDGET_ASYNC_JS_KB ?? 180),
  asyncCssKb: Number(process.env.OPENCLAW_UI_BUDGET_ASYNC_CSS_KB ?? 25),
};

function toKb(bytes) {
  return bytes / 1024;
}

function extractAssetRefs(indexHtml, pattern, extension) {
  const refs = [];
  for (const match of indexHtml.matchAll(pattern)) {
    const rawRef = match[1];
    if (!rawRef) {
      continue;
    }
    const normalizedRef = rawRef.trim();
    const assetMatch = normalizedRef.match(
      new RegExp(`(?:^|\\/)(assets\\/[^"?#]+\\.${extension})(?:[?#].*)?$`, "i"),
    );
    if (assetMatch?.[1]) {
      refs.push(assetMatch[1]);
    }
  }
  return refs;
}

async function readIndexAssets() {
  const indexHtml = await fs.readFile(path.join(distDir, "index.html"), "utf8");
  const jsRefs = extractAssetRefs(indexHtml, /<script[^>]+src="([^"]+\.js)"/g, "js");
  const cssRefs = extractAssetRefs(indexHtml, /<link[^>]+href="([^"]+\.css)"/g, "css");
  return { jsRefs, cssRefs };
}

async function statAssets() {
  const files = await fs.readdir(assetsDir);
  const stats = await Promise.all(
    files.map(async (name) => {
      const fullPath = path.join(assetsDir, name);
      const info = await fs.stat(fullPath);
      return { name, fullPath, bytes: info.size };
    }),
  );
  return stats;
}

function formatAsset(name, bytes) {
  return `${name} (${toKb(bytes).toFixed(2)} KB)`;
}

async function main() {
  const [{ jsRefs, cssRefs }, assets] = await Promise.all([readIndexAssets(), statAssets()]);
  const assetMap = new Map(assets.map((entry) => [entry.name, entry]));
  const failures = [];

  for (const ref of jsRefs) {
    const asset = assetMap.get(path.basename(ref));
    if (!asset) {
      failures.push(`Missing initial JS asset: ${ref}`);
      continue;
    }
    if (toKb(asset.bytes) > budgets.initialJsKb) {
      failures.push(
        `Initial JS budget exceeded: ${formatAsset(asset.name, asset.bytes)} > ${budgets.initialJsKb} KB`,
      );
    }
  }

  for (const ref of cssRefs) {
    const asset = assetMap.get(path.basename(ref));
    if (!asset) {
      failures.push(`Missing initial CSS asset: ${ref}`);
      continue;
    }
    if (toKb(asset.bytes) > budgets.initialCssKb) {
      failures.push(
        `Initial CSS budget exceeded: ${formatAsset(asset.name, asset.bytes)} > ${budgets.initialCssKb} KB`,
      );
    }
  }

  for (const asset of assets) {
    if (jsRefs.some((ref) => path.basename(ref) === asset.name)) {
      continue;
    }
    if (cssRefs.some((ref) => path.basename(ref) === asset.name)) {
      continue;
    }
    if (asset.name.endsWith(".js") && toKb(asset.bytes) > budgets.asyncJsKb) {
      failures.push(
        `Async JS budget exceeded: ${formatAsset(asset.name, asset.bytes)} > ${budgets.asyncJsKb} KB`,
      );
    }
    if (asset.name.endsWith(".css") && toKb(asset.bytes) > budgets.asyncCssKb) {
      failures.push(
        `Async CSS budget exceeded: ${formatAsset(asset.name, asset.bytes)} > ${budgets.asyncCssKb} KB`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("OpenClaw UI build budgets failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("OpenClaw UI build budgets passed.");
}

await main();
