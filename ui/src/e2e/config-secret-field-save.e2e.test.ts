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

const storedConfig = { logging: { level: "info", apiToken: "__OPENCLAW_REDACTED__" } };
const storedSnapshot = {
  ...snapshot,
  config: storedConfig,
  sourceConfig: storedConfig,
  runtimeConfig: storedConfig,
  parsed: storedConfig,
  raw: JSON.stringify(storedConfig),
};
// What the Gateway sends when the file holds "Bearer ${TOKEN}": redacted like plaintext, no text.
const templateSnapshot = { ...storedSnapshot, raw: null };
const include = { logging: { $include: "./logging.json5" } };
const includeSnapshot = { ...storedSnapshot, parsed: include, raw: JSON.stringify(include) };

async function openForm(page: Page, current: Record<string, unknown> = snapshot) {
  await page.clock.install();
  const gateway = await installMockGateway(page, {
    featureMethods: [...defaultControlUiFeatureMethods, "config.patch", "config.set"],
    methodResponses: {
      "config.get": current,
      "config.schema": schema,
      "config.set": { ok: true, config, hash: "base" },
      "config.patch": { ok: true, config, hash: "base" },
    },
  });
  await page.goto(`${suite.server.baseUrl}settings/advanced?section=logging`);
  const token = page.getByRole("textbox", { name: "API token", exact: true });
  await token.waitFor();
  return { gateway, token };
}

suite.define(() => {
  it("holds a secret field while the field beside it keeps autosaving", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { gateway, token } = await openForm(page);
      const save = page.getByRole("button", { name: "Save: API token", exact: true });
      const cancel = page.getByRole("button", { name: "Cancel: API token", exact: true });
      const row = page.locator(".settings-row").filter({ has: token }).last();
      const rowBefore = await row.boundingBox();
      const fieldBefore = await token.boundingBox();
      expect(await token.evaluate((input: HTMLInputElement) => input.autocomplete)).toBe("off");
      expect(await token.evaluate((input: HTMLInputElement) => input.spellcheck)).toBe(false);

      await token.fill(PARTIAL);
      await save.waitFor();
      expect(await token.getAttribute("type")).toBe("password");
      // Save and Cancel sit beside the field: the row keeps its height and the field its left edge.
      expect(await row.boundingBox()).toEqual(rowBefore);
      const field = (await token.boundingBox())!;
      expect(field.x).toBe(fieldBefore!.x);
      expect(field.height).toBe(fieldBefore!.height);
      const saveBox = (await save.boundingBox())!;
      expect(saveBox.x).toBeGreaterThanOrEqual(field.x + field.width);
      expect(saveBox.height).toBe(field.height);
      await page.clock.runFor(1500);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      expect(await gateway.getRequests("config.set")).toHaveLength(0);

      await page.clock.resume();
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
      const idleSave = (await save.boundingBox())!;
      await gateway.deferNext("config.patch");
      await save.click();
      const request = await gateway.waitForRequest("config.patch");
      expect(JSON.parse((request.params as { raw: string }).raw)).toEqual({
        logging: { apiToken: PARTIAL },
      });
      // "Saving…" keeps the button's footprint, so the field doesn't move while it waits.
      expect(await save.getAttribute("aria-busy")).toBe("true");
      expect(await save.boundingBox()).toEqual(idleSave);
      const savingField = await token.boundingBox();
      await gateway.resolveDeferred("config.patch", {
        ok: true,
        config: { logging: { level: "debug", apiToken: PARTIAL } },
        hash: "next",
      });
      await page.getByRole("status").filter({ hasText: "Saved" }).first().waitFor();
      expect(await save.count()).toBe(0);
      expect(await token.boundingBox()).toEqual(savingField);
      expect(await row.boundingBox()).toEqual(rowBefore);
    });
  });

  it("replaces a stored secret on Save, and leaves it alone on Cancel", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { gateway, token } = await openForm(page, storedSnapshot);
      const save = page.getByRole("button", { name: "Save: API token", exact: true });
      expect(await token.inputValue()).toBe("");
      expect(await token.getAttribute("readonly")).toBeNull();
      expect(await token.getAttribute("placeholder")).toBe("••••••••");
      const reveal = page.getByRole("button", { name: "Reveal value", exact: true });
      expect(await reveal.count()).toBe(0);

      await token.fill(PARTIAL);
      expect(await token.getAttribute("type")).toBe("password");
      await reveal.click();
      expect(await token.getAttribute("type")).toBe("text");
      expect(await token.inputValue()).toBe(PARTIAL);
      await page.getByRole("button", { name: "Cancel: API token", exact: true }).click();
      await expect.poll(() => reveal.count()).toBe(0);
      await token.fill(PARTIAL);
      expect(await token.getAttribute("type")).toBe("password");
      await page.getByRole("button", { name: "Cancel: API token", exact: true }).click();
      await expect.poll(() => save.count()).toBe(0);
      expect(await token.inputValue()).toBe("");
      await token.fill(PARTIAL);
      await token.fill("");
      await expect.poll(() => save.count()).toBe(0);
      await page.clock.runFor(1200);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      expect(await gateway.getRequests("config.set")).toHaveLength(0);

      const ime = await page.context().newCDPSession(page);
      await ime.send("Input.imeSetComposition", { text: "x", selectionStart: 1, selectionEnd: 1 });
      await token.press("Enter");
      await ime.send("Input.insertText", { text: PARTIAL });
      await gateway.deferNext("config.patch");
      await save.click();
      const request = await gateway.waitForRequest("config.patch");
      expect(JSON.parse((request.params as { raw: string }).raw)).toEqual({
        logging: { apiToken: PARTIAL },
      });
      await gateway.resolveDeferred("config.patch", {
        ok: true,
        config: storedConfig,
        hash: "next",
      });
      await page.getByRole("status").filter({ hasText: "Saved" }).first().waitFor();
      expect(await token.inputValue()).toBe("");
      expect(await token.getAttribute("readonly")).toBeNull();
    });
  });

  it("keeps a stored secret read-only when the file holds a template or an include", async () => {
    for (const current of [templateSnapshot, includeSnapshot]) {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const { gateway, token } = await openForm(page, current);
        expect(await token.getAttribute("readonly")).not.toBeNull();
        await token.click();
        await page.keyboard.type(PARTIAL);
        await page.keyboard.press("Enter");
        expect(await token.inputValue()).toBe("");
        expect(await page.getByRole("button", { name: "Save: API token" }).count()).toBe(0);
        await page.clock.runFor(1200);
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
      });
    }
  });

  it("keeps the edit when Save is refused, and when leaving the page", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { gateway, token } = await openForm(page);
      const save = page.getByRole("button", { name: "Save: API token", exact: true });

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
