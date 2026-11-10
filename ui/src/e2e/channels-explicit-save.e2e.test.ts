import type { Page } from "playwright";
import { expect, it } from "vitest";
import { buildChannelWizardMocks } from "../../../scripts/control-ui-mock-channels.ts";
import { emptyPairingSnapshot } from "../pages/channels/pairing.test-support.ts";
import { answerConfirmModal } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { configSchema, objectSchema } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Channels explicit save",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const PARTIAL = "123456:PARTIAL";
const config = {
  channels: { telegram: { enabled: true, dmPolicy: "pairing" } },
};
const snapshot = {
  config,
  sourceConfig: config,
  runtimeConfig: config,
  raw: JSON.stringify(config),
  hash: "channel-config",
  configRevisionHash: "channel-config",
  appliedConfigHash: "channel-config",
  issues: [],
  valid: true,
};
const schema = configSchema(
  objectSchema("", {
    channels: objectSchema("", {
      telegram: objectSchema("Telegram", {
        botToken: { type: "string", title: "Bot Token" },
      }),
    }),
  }),
  { "channels.telegram.botToken": { sensitive: true, advanced: false } },
);

const storedConfig = {
  channels: { telegram: { enabled: true, dmPolicy: "pairing", botToken: "__OPENCLAW_REDACTED__" } },
};
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

async function openChannels(page: Page, current: Record<string, unknown> = snapshot) {
  const wizard = buildChannelWizardMocks();
  const gateway = await installMockGateway(page, {
    featureMethods: [
      ...defaultControlUiFeatureMethods,
      "config.patch",
      "wizard.start",
      "wizard.next",
    ],
    methodResponses: {
      "plugins.list": { plugins: [], diagnostics: [], mutationAllowed: true },
      "plugins.controlUi.list": { plugins: [], diagnostics: [], revision: "empty" },
      "channels.status": {
        ts: Date.now(),
        channelOrder: ["telegram"],
        channelLabels: { telegram: "Telegram" },
        channels: { telegram: { configured: true, running: true, connected: true } },
        channelAccounts: {},
        channelDefaultAccountId: {},
        channelMeta: [{ id: "telegram", label: "Telegram" }],
      },
      "wizard.start": wizard.start,
      "wizard.next": wizard.next,
      "channels.pairing.list": emptyPairingSnapshot(),
      "config.get": current,
      "config.schema": schema,
      "config.patch": { ok: true, config, hash: "channel-config" },
    },
  });
  await page.goto(`${suite.server.baseUrl}settings/profile`);
  await page.getByRole("link", { name: "Channels", exact: true }).first().click();
  await page.locator(".channels-item").filter({ hasText: "Telegram" }).first().click();
  const detail = page.locator(".channels-detail");
  const token = detail.locator('input[type="password"]').first();
  await token.waitFor();
  return { gateway, detail, token };
}

/** Answers the unsaved-changes prompt; the dialog behind it has its own Discard and Save. */
async function choose(page: Page, name: "Keep editing" | "Discard" | "Save") {
  await answerConfirmModal(page, /^Save changes to /u, name);
}

suite.define(() => {
  it("holds a partial credential until Save, across closing and leaving", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { gateway, detail, token } = await openChannels(page);
      const writes = async () =>
        (await gateway.getRequests("config.set")).length +
        (await gateway.getRequests("config.patch")).length;
      const status = detail.getByRole("status");

      await token.fill(PARTIAL);
      await expect.poll(() => status.textContent()).toBe("Unsaved changes");
      await expect.poll(() => status.isVisible()).toBe(true);
      await page.waitForTimeout(1500);
      expect(await writes()).toBe(0);

      await detail.getByRole("button", { name: "Close", exact: true }).click();
      const confirmation = page.getByRole("dialog", {
        name: "Save changes to Telegram?",
        exact: true,
      });
      await expect
        .poll(() => confirmation.textContent())
        .toContain("Your changes to Telegram aren’t saved. Discarding removes them.");
      await choose(page, "Keep editing");
      expect(await token.inputValue()).toBe(PARTIAL);
      expect(await writes()).toBe(0);

      await page.goBack();
      const review = page.getByRole("button", { name: "Review", exact: true });
      await review.waitFor();
      expect(await writes()).toBe(0);
      await page.getByRole("link", { name: "Channels", exact: true }).first().click();
      const row = page.locator(".channels-item").filter({ hasText: "Telegram" }).first();
      await expect.poll(() => row.textContent()).toContain("Unsaved changes");
      expect(await detail.count()).toBe(0);
      await review.click();
      await token.waitFor();
      expect(await token.inputValue()).toBe(PARTIAL);
      expect(await writes()).toBe(0);

      await gateway.deferNext("config.patch");
      await detail.getByRole("button", { name: "Save", exact: true }).click();
      const request = await gateway.waitForRequest("config.patch");
      const params = request.params as { raw: string; baseHash: string };
      expect(params.baseHash).toBe("channel-config");
      expect(JSON.parse(params.raw)).toEqual({ channels: { telegram: { botToken: PARTIAL } } });
      await gateway.resolveDeferred("config.patch", {
        config: { channels: { telegram: { ...config.channels.telegram, botToken: PARTIAL } } },
        hash: "channel-config-2",
      });
      await expect.poll(() => status.textContent()).toBe("Saved");
    });
  });

  for (const gesture of ["Escape", "backdrop"] as const) {
    it(`keeps the dialog open after ${gesture} and Keep editing, and closes it on Discard`, async () => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const { gateway, detail, token } = await openChannels(page);
        const dismiss = async () => {
          if (gesture === "Escape") {
            await token.press("Escape");
          } else {
            // Outside the 680px dialog, on the backdrop.
            await page.mouse.click(12, 450);
          }
        };
        await token.fill(PARTIAL);

        await dismiss();
        await choose(page, "Keep editing");
        await expect.poll(() => detail.isVisible()).toBe(true);
        expect(await token.inputValue()).toBe(PARTIAL);
        await token.fill(`${PARTIAL}2`);
        expect(await token.inputValue()).toBe(`${PARTIAL}2`);

        await dismiss();
        await choose(page, "Discard");
        await expect.poll(() => detail.count()).toBe(0);
        const row = page.locator(".channels-item").filter({ hasText: "Telegram" }).first();
        expect(await row.textContent()).not.toContain("Unsaved changes");
        await row.click();
        await token.waitFor();
        expect(await token.inputValue()).not.toContain(PARTIAL);
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      });
    });
  }

  it("asks before Run setup, and starts setup once the edits are saved", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { gateway, detail, token } = await openChannels(page);
      const runSetup = detail.getByRole("button", { name: "Run setup", exact: true });
      await token.fill(PARTIAL);

      await runSetup.click();
      await choose(page, "Keep editing");
      await expect.poll(() => detail.isVisible()).toBe(true);
      expect(await token.inputValue()).toBe(PARTIAL);
      expect(await gateway.getRequests("wizard.start")).toHaveLength(0);

      await runSetup.click();
      await choose(page, "Save");
      const request = await gateway.waitForRequest("config.patch");
      expect(JSON.parse((request.params as { raw: string }).raw)).toEqual({
        channels: { telegram: { botToken: PARTIAL } },
      });
      await gateway.waitForRequest("wizard.start");
      await page.locator(".channels-wizard").waitFor();
      expect(await detail.count()).toBe(0);
    });
  });

  it("replaces a stored token only with what was typed", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { gateway, detail, token } = await openChannels(page, storedSnapshot);
      const status = detail.getByRole("status");
      expect(await token.inputValue()).toBe("");
      expect(await token.getAttribute("readonly")).toBeNull();
      expect(await token.getAttribute("placeholder")).toBe("••••••••");

      await token.fill(PARTIAL);
      await expect.poll(() => status.textContent()).toBe("Unsaved changes");
      await token.fill("");
      await expect
        .poll(() => detail.getByRole("status").filter({ hasText: "Unsaved changes" }).count())
        .toBe(0);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);

      await token.fill(PARTIAL);
      await gateway.deferNext("config.patch");
      await detail.getByRole("button", { name: "Save", exact: true }).click();
      const request = await gateway.waitForRequest("config.patch");
      expect(JSON.parse((request.params as { raw: string }).raw)).toEqual({
        channels: { telegram: { botToken: PARTIAL } },
      });
      await gateway.resolveDeferred("config.patch", {
        ok: true,
        config: storedConfig,
        hash: "channel-config-2",
      });
      await expect.poll(() => status.textContent()).toBe("Saved");
    });
  });

  it("keeps a stored token read-only when the file holds a template", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { gateway, detail, token } = await openChannels(page, templateSnapshot);
      expect(await token.getAttribute("readonly")).not.toBeNull();
      await token.click();
      await page.keyboard.type(PARTIAL);
      expect(await token.inputValue()).toBe("");
      expect(await detail.getByRole("status").filter({ hasText: "Unsaved changes" }).count()).toBe(
        0,
      );
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
    });
  });

  it("keeps the edit when Save fails, and discards it only when asked", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const { gateway, detail, token } = await openChannels(page);
      await token.fill(PARTIAL);
      await gateway.deferNext("config.patch");
      await detail.getByRole("button", { name: "Save", exact: true }).click();
      await gateway.waitForRequest("config.patch");
      await gateway.rejectDeferred("config.patch", {
        code: "INVALID_REQUEST",
        message: "Bot token format is invalid",
      });
      await expect.poll(() => detail.getByRole("alert").textContent()).toContain("invalid");
      expect(await token.inputValue()).toBe(PARTIAL);
      expect(await detail.getByRole("status").textContent()).toBe("Unsaved changes");
      expect(await gateway.getRequests("config.set")).toHaveLength(0);

      // Discard in the footer drops the edit and what its rejected Save reported, in place.
      await detail.getByRole("button", { name: "Discard", exact: true }).click();
      await expect.poll(() => detail.getByRole("alert").count()).toBe(0);
      expect(await detail.isVisible()).toBe(true);
      expect(await token.inputValue()).not.toBe(PARTIAL);
      expect(await detail.getByRole("status").count()).toBe(0);
      expect(await detail.getByRole("button", { name: "Save", exact: true }).count()).toBe(0);
      await detail.getByRole("button", { name: "Close", exact: true }).click();
      await expect.poll(() => detail.count()).toBe(0);
    });
  });
});
