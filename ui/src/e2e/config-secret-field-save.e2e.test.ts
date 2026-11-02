import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { configSchema, objectSchema } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Secret field save",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const PARTIAL = "partial-token";
const config = { logging: { level: "info", apiToken: undefined } };
const snapshot = {
  config,
  sourceConfig: config,
  runtimeConfig: config,
  raw: JSON.stringify(config),
  hash: "base",
  configRevisionHash: "base",
  appliedConfigHash: "base",
  issues: [],
  valid: true,
};
const schema = configSchema(
  objectSchema("", {
    logging: objectSchema("Logging", {
      level: { type: "string", title: "Level" },
      apiToken: { type: "string", title: "Api Token" },
    }),
  }),
  {
    "logging.level": { advanced: false },
    "logging.apiToken": { sensitive: true, advanced: false },
  },
);

async function openForm(page: Page) {
  const gateway = await installMockGateway(page, {
    featureMethods: [...defaultControlUiFeatureMethods, "config.patch", "config.set"],
    methodResponses: {
      "config.get": snapshot,
      "config.schema": schema,
      "config.set": { ok: true, config, hash: "base" },
      "config.patch": { ok: true, config, hash: "base" },
    },
  });
  await page.goto(`${suite.server.baseUrl}settings/advanced?section=logging`);
  const token = page.getByRole("textbox", { name: "Api Token", exact: true });
  await token.waitFor();
  return { gateway, token };
}

suite.define(() => {
  it("holds a secret field while the field beside it keeps autosaving", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { gateway, token } = await openForm(page);
      const save = page.getByRole("button", { name: "Save: Api Token", exact: true });
      const cancel = page.getByRole("button", { name: "Cancel: Api Token", exact: true });
      const before = await token.boundingBox();

      await token.fill(PARTIAL);
      await save.waitFor();
      expect(await token.getAttribute("type")).toBe("password");
      expect(await token.boundingBox()).toEqual(before);
      await page.waitForTimeout(1500);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      expect(await gateway.getRequests("config.set")).toHaveLength(0);

      const level = page.getByRole("textbox", { name: "Level", exact: true });
      await level.fill("debug");
      await gateway.waitForRequest("config.set");
      const autosave = (await gateway.getRequests("config.set"))[0]?.params as { raw: string };
      expect(autosave.raw).toContain("debug");
      expect(autosave.raw).not.toContain(PARTIAL);
      expect(await token.inputValue()).toBe(PARTIAL);

      await cancel.click();
      await expect.poll(() => save.count()).toBe(0);
      expect(await token.inputValue()).toBe("");

      await token.fill(PARTIAL);
      await gateway.deferNext("config.patch");
      await save.click();
      const request = await gateway.waitForRequest("config.patch");
      expect(JSON.parse((request.params as { raw: string }).raw)).toEqual({
        logging: { apiToken: PARTIAL },
      });
      await gateway.resolveDeferred("config.patch", {
        ok: true,
        config: { logging: { level: "debug", apiToken: PARTIAL } },
        hash: "next",
      });
      await page.getByRole("status").filter({ hasText: "Saved" }).first().waitFor();
      expect(await save.count()).toBe(0);
    });
  });

  it("keeps the edit when Save is refused, and when leaving the page", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { gateway, token } = await openForm(page);
      const save = page.getByRole("button", { name: "Save: Api Token", exact: true });

      await token.fill(PARTIAL);
      await gateway.deferNext("config.patch");
      await save.click();
      await gateway.waitForRequest("config.patch");
      await gateway.rejectDeferred("config.patch", {
        code: "INVALID_REQUEST",
        message: "Token format is invalid",
      });
      await page.getByRole("alert").filter({ hasText: "Token format is invalid" }).waitFor();
      expect(await token.inputValue()).toBe(PARTIAL);
      expect(await save.isEnabled()).toBe(true);
      expect(await gateway.getRequests("config.set")).toHaveLength(0);

      await page.getByRole("link", { name: "Profile", exact: true }).first().click();
      await page.getByRole("button", { name: "Review", exact: true }).click();
      await token.waitFor();
      expect(await token.inputValue()).toBe(PARTIAL);
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
    });
  });
});
