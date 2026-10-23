import type { BrowserContextOptions } from "playwright";
import type { ModelCatalogEntry } from "../api/types.ts";

export function catalogModel(
  provider: string,
  id: string,
  name: string,
  available = true,
): ModelCatalogEntry {
  return { provider, id, name, available };
}

export function emptyUsage(now: number) {
  return {
    "usage.status": { updatedAt: now, providers: [] },
    "sessions.usage": { aggregates: { byProvider: [] } },
  };
}

export function keyCapabilities(...providers: string[]) {
  return providers.map((provider) => ({ provider, apiKeySupported: true, quickApiKeySetup: true }));
}

export function providerPageOptions(
  width: number,
  height: number,
  options: BrowserContextOptions = {},
): BrowserContextOptions {
  return { locale: "en-US", serviceWorkers: "block", viewport: { width, height }, ...options };
}

export function configAuth(provider: string) {
  return { provider, profiles: [], apiKey: { source: "config" } };
}
