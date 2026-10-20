import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  configSnapshot,
  objectSchema,
  pageRunner,
} from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI config open-file feedback mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const configPath = "/tmp/openclaw-config-open-feedback/openclaw.json";
const withPage = pageRunner(suite, { serviceWorkers: "block" });
const openButton = (page: Page) => page.getByRole("button", { name: "Open", exact: true });

async function installClipboardProof(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const copied: string[] = [];
    Object.defineProperty(globalThis, "configOpenFileCopied", { value: copied });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    });
  });
}

async function openRawSettings(page: Page, response?: unknown) {
  await installClipboardProof(page);
  const config = { laboratory: { enabled: true } };
  const gateway = await installMockGateway(page, {
    featureMethods: ["config.openFile"],
    methodResponses: {
      "config.get": { ...configSnapshot(config, "config-open-file-feedback"), path: configPath },
      "config.schema": {
        schema: objectSchema("", {
          laboratory: objectSchema("", { enabled: { type: "boolean" } }),
        }),
        uiHints: {},
        version: "config-open-file-feedback",
      },
      ...(response === undefined ? {} : { "config.openFile": response }),
    },
    operatorScopes: ["operator.read", "operator.admin"],
  });
  const navigation = await page.goto(`${suite.server.baseUrl}settings/advanced?section=laboratory`);
  expect(navigation?.status()).toBe(200);
  await page.getByRole("button", { name: "Raw", exact: true }).click();
  return gateway;
}

async function expectOpenFailure(page: Page, message: string): Promise<void> {
  const status = page.getByRole("status").filter({ hasText: message });
  await expect.poll(() => status.count()).toBe(1);
  await expect.poll(() => status.textContent()).toContain("File path copied to clipboard");
  await expect.poll(() => status.textContent()).toContain(configPath);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "configOpenFileCopied")))
    .toEqual([configPath]);
  expect(await page.getByText("Save failed", { exact: true }).count()).toBe(0);
  expect(await page.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0);
  expect(await page.locator(".settings-save-indicator").count()).toBe(0);
}

suite.define(() => {
  it("announces when the host opener succeeds", async () => {
    await withPage(async ({ page }) => {
      await openRawSettings(page, { ok: true, path: configPath });
      await openButton(page).click();

      const status = page
        .getByRole("status")
        .filter({ hasText: "Configuration file opened on Gateway host." });
      await expect.poll(() => status.count()).toBe(1);
      expect(await status.textContent()).not.toContain(configPath);
      expect(await page.evaluate(() => Reflect.get(globalThis, "configOpenFileCopied"))).toEqual(
        [],
      );
    });
  });

  it("announces the path fallback when the host opener returns a failure", async () => {
    await withPage(async ({ page }) => {
      await openRawSettings(page, {
        ok: false,
        path: configPath,
        error: "No desktop opener is available.",
      });

      await openButton(page).click();

      await expectOpenFailure(page, "No desktop opener is available.");
    });
  });

  it("announces the path fallback when the open request rejects", async () => {
    await withPage(async ({ page }) => {
      const gateway = await openRawSettings(page);
      await gateway.deferNext("config.openFile");

      await openButton(page).click();
      await gateway.waitForRequest("config.openFile");
      await gateway.rejectDeferred("config.openFile", {
        code: "UNAVAILABLE",
        message: "No desktop opener is available.",
      });

      await expectOpenFailure(page, "No desktop opener is available.");
    });
  });
});
