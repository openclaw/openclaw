import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { configSnapshot, objectSchema } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI config open-file feedback mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const configPath = "/tmp/openclaw-config-open-feedback/openclaw.json";
const openerError = "No desktop opener is available.";

async function openRawSettings(page: Page, response?: unknown) {
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
  it.each(["succeeds", "returns a failure", "rejects"])(
    "announces the outcome when the open request %s",
    async (outcome) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const rejects = outcome === "rejects";
        const ok = outcome === "succeeds";
        const gateway = await openRawSettings(
          page,
          rejects ? undefined : { ok, path: configPath, ...(ok ? {} : { error: openerError }) },
        );
        if (rejects) {
          await gateway.deferNext("config.openFile");
        }
        await page.getByRole("button", { name: "Open", exact: true }).click();
        if (rejects) {
          await gateway.waitForRequest("config.openFile");
          await gateway.rejectDeferred("config.openFile", {
            code: "UNAVAILABLE",
            message: openerError,
          });
        }
        if (!ok) {
          await expectOpenFailure(page, openerError);
        } else {
          const status = page
            .getByRole("status")
            .filter({ hasText: "Configuration file opened on Gateway host." });
          await expect.poll(() => status.count()).toBe(1);
          expect(await status.textContent()).not.toContain(configPath);
          expect(
            await page.evaluate(() => Reflect.get(globalThis, "configOpenFileCopied")),
          ).toEqual([]);
        }
      });
    },
  );
});
