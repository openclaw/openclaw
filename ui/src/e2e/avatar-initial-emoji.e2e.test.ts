import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { pageRunner } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { themeConfigResponse } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI identity emoji avatars",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const withPage = pageRunner(suite, {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1440 },
});

const asciiAgent = { id: "main", identity: { name: "Main" }, name: "Main" };
const emojiGrapheme = "🚀";

suite.define(() => {
  it("renders the identity emoji in the agents overview identity editor", async () => {
    await withPage(async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(Crypto.prototype, "randomUUID", {
          configurable: true,
          value: undefined,
        });
      });
      await seedChatSettings(page, suite.server.baseUrl, { theme: "crt", themeMode: "dark" });
      const themed = themeConfigResponse("crt", "dark");
      const config = { ...themed.config, agents: { entries: { main: {}, emoji: {} } } };
      const hydratedEmojiAgent = { id: "emoji", identity: { name: "Rocket" }, name: "Rocket" };
      const gateway = await installMockGateway(page, {
        defaultAgentId: "main",
        featureMethods: [...defaultControlUiFeatureMethods, "agents.update"],
        methodResponses: {
          "agents.update": { ok: true },
          "agent.identity.get": {
            cases: [
              {
                match: { agentId: "emoji" },
                response: {
                  agentId: "emoji",
                  avatar: "",
                  avatarStatus: "none",
                  emoji: emojiGrapheme,
                  name: "Rocket",
                },
              },
              {
                match: { agentId: "main" },
                response: { agentId: "main", avatar: "", avatarStatus: "none", name: "Main" },
              },
            ],
          },
          "agents.list": {
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
            agents: [asciiAgent, hydratedEmojiAgent],
          },
          "config.get": {
            ...themed,
            config,
            sourceConfig: config,
            raw: JSON.stringify(config),
          },
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/agents/main/tools`);
      expect(response?.status()).toBe(200);
      expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
      expect(await page.evaluate(() => typeof crypto.getRandomValues)).toBe("function");
      await gateway.waitForRequest("agents.list");
      await gateway.waitForRequest("config.get");
      const agentSelect = page.locator(".settings-sidebar__agent openclaw-agent-select");
      await agentSelect.locator(".agent-select__trigger").click();
      await agentSelect.getByRole("menuitemradio", { name: "Rocket", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/emoji/tools");
      await page.getByRole("tab", { name: "Overview", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/emoji/overview");
      const picker = page.locator("openclaw-agent-emoji-picker");
      const emojiInput = page.locator(".agent-identity-editor__emoji").getByRole("textbox", {
        name: "Emoji",
      });
      await expect.poll(() => emojiInput.inputValue()).toBe(emojiGrapheme);
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("crt");
      await expect
        .poll(() =>
          page
            .locator("#openclaw-theme-palette-crt")
            .evaluate((link: HTMLLinkElement) => Boolean(link.sheet)),
        )
        .toBe(true);
      await page.evaluate(() => document.fonts.ready);
      for (const avatar of [
        agentSelect.locator(".agent-select__trigger .agent-select__avatar"),
        page.locator(".agent-identity-editor__avatar .identity-avatar--agent"),
      ]) {
        await avatar.locator('.identity-avatar__text[data-avatar="🚀"]').waitFor();
        const offset = await avatar.evaluate((element) => {
          const outer = element.getBoundingClientRect();
          const radius = getComputedStyle(element).borderTopLeftRadius;
          const text = element.querySelector(".identity-avatar__text")!.getBoundingClientRect();
          return {
            round:
              outer.width > 0 &&
              outer.width === outer.height &&
              (radius.endsWith("%")
                ? Number.parseFloat(radius) >= 50
                : Number.parseFloat(radius) >= outer.width / 2),
            x: text.x + text.width / 2 - outer.x - outer.width / 2,
            y: text.y + text.height / 2 - outer.y - outer.height / 2,
          };
        });
        expect.soft(offset.round).toBe(true);
        expect.soft(Math.abs(offset.x)).toBeLessThanOrEqual(1);
        expect.soft(Math.abs(offset.y)).toBeLessThanOrEqual(1);
      }
      await picker.getByRole("button", { name: "Choose emoji" }).click();
      await expect.poll(() => picker.getByRole("button", { name: "lobster" }).count()).toBe(1);
      expect(await picker.getByRole("textbox", { name: "Paste another emoji" }).count()).toBe(0);
      expect(await picker.getByRole("button", { name: "Use", exact: true }).count()).toBe(0);
      await picker.getByRole("searchbox", { name: "Search emoji…" }).fill("dolphin");
      await picker.getByRole("button", { name: "dolphin", exact: true }).click();
      await expect.poll(() => emojiInput.inputValue()).toBe("🐬");
      const beforeBoundedSave = (await gateway.getRequests("agents.update")).length;
      await emojiInput.fill("🪿".repeat(20));
      await expect.poll(() => emojiInput.inputValue()).toBe("🪿".repeat(4));
      const boundedUpdate = await gateway.waitForRequest("agents.update", {
        after: beforeBoundedSave,
      });
      expect(boundedUpdate.params).toMatchObject({ agentId: "emoji", emoji: "🪿".repeat(4) });
      const beforeTypedSave = (await gateway.getRequests("agents.update")).length;
      await emojiInput.fill("👨‍👩‍👧‍👦".repeat(3));
      await expect.poll(() => emojiInput.inputValue()).toBe("👨‍👩‍👧‍👦");
      await emojiInput.fill("🪿");
      await expect.poll(() => emojiInput.inputValue()).toBe("🪿");
      const update = await gateway.waitForRequest("agents.update", { after: beforeTypedSave });
      expect(update.params).toMatchObject({ agentId: "emoji", emoji: "🪿" });
      const avatar = page.locator(".agent-identity-editor__avatar .identity-avatar__text");
      await expect.poll(() => avatar.getAttribute("data-avatar")).toBe(emojiGrapheme);
      await expect
        .poll(() => avatar.evaluate((element) => getComputedStyle(element, "::before").content))
        .toContain(emojiGrapheme);
    });
  });
});
