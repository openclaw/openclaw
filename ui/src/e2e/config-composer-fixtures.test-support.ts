import path from "node:path";
import type { BrowserContext, BrowserContextOptions, Locator, Page } from "playwright";
import { beforeEach, expect } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export function createConfigSuite(name: string) {
  return createControlUiE2eSuite({
    name,
    startServerBeforeBrowser: true,
    unavailableMessage: (executablePath) =>
      `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
  });
}

export function createSettingsPageOptions() {
  return {
    colorScheme: "dark",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 1000, width: 1440 },
  } satisfies BrowserContextOptions;
}

export const settingsPageOptions = createSettingsPageOptions();

export function configProof(name: string, variant?: string) {
  const enabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
  let directory: string;
  beforeEach(() => {
    if (enabled) {
      const root = createControlUiE2eArtifactDir(name);
      directory = variant ? path.join(root, variant) : root;
    }
  });
  const capture = async (surface: Page | Locator, fileName: string, fullPage = false) => {
    if (enabled) {
      await surface.screenshot({
        animations: "disabled",
        path: path.join(directory, fileName),
        ...(fullPage ? { fullPage: true } : {}),
      });
    }
  };
  return { enabled, directory: () => directory, capture };
}

export function pageRunner(
  suite: ReturnType<typeof createControlUiE2eSuite>,
  defaults: BrowserContextOptions | (() => BrowserContextOptions),
) {
  return <T>(run: Parameters<typeof suite.withPage<T>>[1], options: BrowserContextOptions = {}) =>
    suite.withPage(
      { ...(typeof defaults === "function" ? defaults() : defaults), ...options },
      run,
    );
}

export function configSnapshot(config: Record<string, unknown>, hash: string, revisions = false) {
  return {
    ...(revisions ? { appliedConfigHash: hash, configRevisionHash: hash } : {}),
    config,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

export function objectSchema(
  title: string,
  properties: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return { type: "object", ...(title ? { title } : {}), properties, ...extra };
}

export function configSchema(schema: Record<string, unknown>, uiHints = {}) {
  return { generatedAt: "2026-08-01T00:00:00.000Z", schema, uiHints, version: "e2e" };
}

export function computedStyles(control: Locator, names: readonly string[]) {
  return control.evaluate((element, properties) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(properties.map((name) => [name, style.getPropertyValue(name)]));
  }, names);
}

export async function revealControl(control: Locator) {
  await expect.poll(() => control.count()).toBe(1);
  for (const details of await control.locator("xpath=ancestor::details").all()) {
    if ((await details.getAttribute("open")) === null) {
      await details.locator(":scope > summary").click();
    }
  }
  await expect.poll(() => control.isVisible()).toBe(true);
}

export function settingsRow(page: Page, title: string): Locator {
  return page.locator(".settings-row").filter({
    has: page.locator(".settings-row__title").getByText(title, { exact: true }),
  });
}

export async function composerStore(page: Page) {
  const module = await page.evaluateHandle<
    typeof import("../lib/chat/composer-draft-store.runtime.ts")
  >('import("/src/lib/chat/composer-draft-store.runtime.ts")');
  return module.evaluateHandle((store) => ({
    read: store.readDurableComposerDraft,
    write: store.writeDurableComposerDraft,
    retire: store.retireDurableComposerDraft,
    restore: store.restoreDurableComposerRecovery,
    prepare: store.prepareDurableComposerRecovery,
    seed(
      scope: Parameters<typeof store.writeDurableComposerDraft>[0],
      text: string,
      revision: number,
      writeId: string,
      attachments: Parameters<typeof store.writeDurableComposerDraft>[1]["attachments"] = [],
    ) {
      return store.writeDurableComposerDraft(
        scope,
        { text, revision, attachments },
        { expectedRevision: 0, writeId },
      );
    },
  }));
}

export function composerStorePage(suite: ReturnType<typeof createControlUiE2eSuite>) {
  return <T>(
    run: (fixture: {
      page: Page;
      context: BrowserContext;
      store: Awaited<ReturnType<typeof composerStore>>;
    }) => Promise<T>,
    route = "settings",
  ) =>
    suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async (fixture) => {
      await installMockGateway(fixture.page);
      await fixture.page.goto(`${suite.server.baseUrl}${route}`);
      return run({ ...fixture, store: await composerStore(fixture.page) });
    });
}
