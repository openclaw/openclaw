import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";
import { createSidebarFooterProofSuite } from "./sidebar-footer-proof.test-support.ts";

const suite = createSidebarFooterProofSuite("Sidebar account identity");
const longName = "Riley Morgan and the extraordinarily long research workspace";
async function openAccount(page: Page, name: string) {
  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ sidebarAgentsMode: "chip" }));
  }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
  const agentsList = {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id: "main", name }],
  };
  await installMockGateway(page, {
    presenceUsers: [{ self: true, id: "riley", name }],
    methodResponses: {
      "agents.list": agentsList,
      "agent.identity.get": { agentId: "main", name },
      "chat.startup": {
        agentsList,
        messages: [],
        metadata: { models: [] },
        sessionId: "account-identity-session",
        thinkingLevel: null,
      },
    },
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  const sidebar = page.locator("openclaw-app-sidebar");
  // The rail account control keeps its full name accessible without widening the rail.
  const account = sidebar.locator(".sidebar-identity-card");
  await expect.poll(() => account.getAttribute("aria-label")).toContain(name);
  await expect.poll(() => sidebar.locator(".sidebar-identity-card__name").textContent()).toBe(name);
  expect(
    await sidebar.locator(".sidebar-identity-card__text").evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      clipPath: getComputedStyle(element).clipPath,
    })),
  ).toEqual({ width: 1, clipPath: "inset(50%)" });
}

suite.define(() => {
  it("uses the icon-only account control to reveal the full profile name on touch", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, hasTouch: true, reducedMotion: "no-preference" },
      async ({ page }) => {
        await openAccount(page, longName);
        const button = page.locator(".sidebar-identity-card");
        const bounds = await button.boundingBox();
        await button.tap();
        await expect.poll(() => button.getAttribute("aria-expanded")).toBe("true");
        const name = page.locator(".sidebar-identity-menu__name");
        await name.waitFor();
        expect(await name.textContent()).toBe(longName);
        expect(await tooltipTitleText(name)).toBe(longName);
        expect(await button.getAttribute("aria-label")).toContain(longName);
        expect(await button.boundingBox()).toEqual(bounds);
        await page.keyboard.press("Escape");
        await expect.poll(() => button.getAttribute("aria-expanded")).toBe("false");
      },
    );
  });
});
