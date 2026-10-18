import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import type { MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { createProviderProofCapture } from "./model-providers.test-support.ts";

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

export function videoPageOptions(
  width: number,
  height: number,
  dir: string,
  options: BrowserContextOptions = {},
) {
  return pageOptions(width, height, {
    ...options,
    ...(process.env.OPENCLAW_UI_E2E_RECORD === "1"
      ? { recordVideo: { dir, size: { width, height } } }
      : {}),
  });
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

export function createScreenshots(
  directory: () => string,
  defaults: NonNullable<Parameters<Page["screenshot"]>[0]> = {},
) {
  return (target: Page | Locator, name: string, options = {}) =>
    recordShot(target, { ...defaults, ...options, path: path.join(directory(), name) });
}

export function createRecordedProviderProof(directory: () => string) {
  const capture = createProviderProofCapture(directory);
  return async (name: string, content: Locator, frame?: Locator) => {
    if (process.env.OPENCLAW_UI_E2E_RECORD !== "1") {
      return;
    }
    if (frame) {
      await writeFile(
        path.join(directory(), name),
        await takeControlUiViewportScreenshot(content.page(), frame, [content]),
      );
    } else {
      await capture(name, content);
    }
  };
}

export function emptyUsage(now: number) {
  return {
    "usage.status": { updatedAt: now, providers: [] },
    "sessions.usage": { aggregates: { byProvider: [] } },
  };
}

export function configKeyProvider(provider: string, displayName: string) {
  return { provider, displayName, status: "static", profiles: [], apiKey: { source: "config" } };
}

export function readyProvider<P, E extends object>(
  provider: string,
  displayName: string,
  profiles: P[],
  details?: E,
) {
  return { provider, displayName, status: "ok", profiles, ...details };
}

export function button(root: Page | Locator, name: string) {
  return root.getByRole("button", { name, exact: true });
}

export function loginCapability<T>(provider: string, loginOptions: T[], apiKey = false) {
  return { provider, apiKeySupported: apiKey, quickApiKeySetup: apiKey, loginOptions };
}

export function runningStep<T>(step: T) {
  return { done: false, status: "running", step };
}

export async function configuredRequests(
  gateway: MockGatewayControls,
  agentId: string,
  refresh: boolean,
) {
  return (await gateway.getRequests("models.list"))
    .map(({ params }) => params)
    .filter(
      (params) =>
        params &&
        typeof params === "object" &&
        "view" in params &&
        params.view === "configured" &&
        "agentId" in params &&
        params.agentId === agentId &&
        ("refresh" in params && params.refresh === true) === refresh,
    );
}
