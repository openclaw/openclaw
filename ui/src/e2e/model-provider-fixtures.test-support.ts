import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect } from "vitest";

export function configSnapshot(config: unknown, hash: string) {
  return {
    config,
    sourceConfig: config,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

export function catalogModel(provider: string, id: string, name: string, available = true) {
  return { id, name, provider, available };
}

export function keyCapability(provider: string) {
  return { provider, apiKeySupported: true, quickApiKeySetup: true };
}

export function authProfile<T extends object>(
  profileId: string,
  type: string,
  status: string,
  details?: T,
) {
  return { profileId, type, status, ...details };
}

export function loginOption<T extends object>(
  id: string,
  brandId: string,
  label: string,
  kind: string,
  featured: boolean,
  details?: T,
) {
  return { id, brandId, label, kind, featured, ...details };
}

export function pageOptions(width: number, height: number, options: BrowserContextOptions = {}) {
  return {
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { width, height },
    ...options,
  } satisfies BrowserContextOptions;
}

export function text(locator: Locator) {
  return expect.poll(() => locator.textContent());
}

export function trimmedText(locator: Locator) {
  return expect.poll(async () => (await locator.textContent())?.trim());
}

export async function recordShot(
  target: Page | Locator,
  options: NonNullable<Parameters<Page["screenshot"]>[0]>,
) {
  if (process.env.OPENCLAW_UI_E2E_RECORD !== "1") {
    return;
  }
  if (options.path) {
    await mkdir(path.dirname(options.path), { recursive: true });
  }
  await target.screenshot(options);
}
