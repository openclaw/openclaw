import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";

export async function writeMarketplaceManifest(
  rootDir: string,
  manifest: unknown,
): Promise<string> {
  const manifestPath = path.join(rootDir, ".claude-plugin", "marketplace.json");
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return manifestPath;
}

export function expectMarketplaceInstallSuccess(
  result: unknown,
  params: {
    pluginId?: string;
    marketplacePlugin?: string;
    marketplaceSource?: string;
  },
) {
  if (!result || typeof result !== "object") {
    throw new Error("expected marketplace install result");
  }
  const record = result as Record<string, unknown>;
  expect(record.ok).toBe(true);
  expect(record.pluginId).toBe(params.pluginId ?? "frontend-design");
  if (params.marketplacePlugin) {
    expect(record.marketplacePlugin).toBe(params.marketplacePlugin);
  }
  if (params.marketplaceSource) {
    expect(record.marketplaceSource).toBe(params.marketplaceSource);
  }
}

export function createMarketplaceInstallInput(mock: { mock: { calls: unknown[][] } }) {
  return function installPluginInput(callIndex = 0): Record<string, unknown> {
    const input = mock.mock.calls[callIndex]?.[0];
    if (!input || typeof input !== "object") {
      throw new Error(`expected install plugin input ${callIndex}`);
    }
    return input as Record<string, unknown>;
  };
}
