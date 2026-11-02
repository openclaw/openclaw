import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForMobileSidebarDrawerOpen } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mobile New conversation" });
const mobile = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  colorScheme: "dark" as const,
};

async function installScenario(page: Page, operatorScopes?: string[], team = false) {
  if (team) {
    await page.addInitScript(
      (key) => localStorage.setItem(key, JSON.stringify({ sidebarAgentsMode: "roster" })),
      controlUiBundledSettingsStorageKey(suite.server.baseUrl),
    );
  }
  return installMockGateway(page, {
    defaultAgentId: "research",
    assistantAgentId: "research",
    assistantName: "Atlas",
    operatorScopes,
    ...(team
      ? {
          methodResponses: {
            "agents.list": {
              defaultId: "research",
              mainKey: "main",
              scope: "per-sender",
              agents: [
                { id: "research", name: "Atlas", model: { primary: "demo/demo-model" } },
                { id: "writer", name: "Scout", model: { primary: "demo/demo-model" } },
              ],
            },
          },
        }
      : {}),
    agentModel: "demo/demo-model",
    models: [{ id: "demo-model", provider: "demo", name: "Demo model", contextWindow: 32000 }],
    sessionKey: "agent:research:current",
    sessions: [
      {
        key: "agent:research:current",
        kind: "direct",
        label: "Launch planning",
        updatedAt: 1791871200000,
      },
    ],
  });
}

suite.define(() => {
  it("docks the mobile New Session composer like the chat composer", async () => {
    await suite.withPage(mobile, async ({ page }) => {
      await installScenario(page, undefined, true);
      const bottomGap = (selector: string) =>
        page
          .locator(selector)
          .evaluate((element) => window.innerHeight - element.getBoundingClientRect().bottom);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:research:current"));
      await page.locator(".agent-chat__composer-combobox textarea").waitFor();
      await waitForLayoutSettled(page, ".chat-footer .agent-chat__composer-shell");
      const chatGap = await bottomGap(".chat-footer .agent-chat__composer-shell");
      await page.goto(suite.server.baseUrl + "new?agent=research");
      const composer = page.locator(".new-session-page__message");
      await composer.fill("Help me plan the next release.");
      const identity = page.locator(".new-session-page .agent-chat__welcome-identity");
      const triggers = page.locator(".new-session-page__triggers");
      const surface = page.locator(".new-session-page__composer");
      const dir =
        process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
          ? createControlUiE2eArtifactDir("mobile-composer-layout")
          : null;
      for (const state of [
        { name: "portrait", width: 390, height: 844, theme: "dark" },
        { name: "wide-phone", width: 430, height: 932, theme: "light" },
        { name: "small-phone", width: 320, height: 568, theme: "dark" },
        // A resized content viewport exercises the layout used above a soft keyboard.
        { name: "keyboard", width: 390, height: 480, theme: "dark" },
        { name: "landscape", width: 844, height: 390, theme: "dark" },
      ] as const) {
        await page.setViewportSize({ width: state.width, height: state.height });
        await page.emulateMedia({ colorScheme: state.theme });
        await expect
          .poll(() => page.locator("html").getAttribute("data-theme-mode"))
          .toBe(state.theme);
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator(".shell"),
          [identity, triggers, surface],
          {
            animations: "disabled",
          },
        );
        if (dir) {
          await writeFile(path.join(dir, state.name + ".png"), frame.png);
        }
        const heroBox = await identity.boundingBox();
        const targetBox = await triggers.boundingBox();
        const composerBox = await surface.boundingBox();
        expect(heroBox).not.toBeNull();
        expect(targetBox).not.toBeNull();
        expect(composerBox).not.toBeNull();
        expect(targetBox!.y - heroBox!.y - heroBox!.height).toBeGreaterThanOrEqual(0);
        expect(heroBox!.y).toBeGreaterThanOrEqual(58);
        expect(
          Math.abs((await bottomGap(".new-session-page__composer")) - chatGap),
          state.name,
        ).toBeLessThanOrEqual(1);
        const local = page.locator("#new-session-where-trigger");
        expect((await local.boundingBox())!.width).toBeLessThanOrEqual(100);
        expect(
          await page.locator(".new-session-page__select--agent .agent-select__label").isVisible(),
        ).toBe(true);
        expect(composerBox!.height).toBeLessThanOrEqual(150);
        expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(state.height);
        expect(composerBox!.x).toBeGreaterThanOrEqual(0);
        expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(state.width);
        expect(await composer.inputValue()).toBe("Help me plan the next release.");
        expect(
          await page
            .locator(".new-session-page__scroll")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      const capture = async (name: string, content = [identity, triggers, surface]) => {
        if (dir) {
          const frame = await takeControlUiScreenshotFrame(page, page.locator(".shell"), content, {
            animations: "disabled",
          });
          await writeFile(path.join(dir, name + ".png"), frame.png);
        }
      };
      await composer.fill("");
      expect(await page.locator(".new-session-page__start-submit").isDisabled()).toBe(true);
      await capture("empty");
      await page.locator("#new-session-where-trigger").tap();
      const destination = page.locator("#new-session-where-popover");
      await destination.waitFor();
      await capture("menu", [destination]);
      const destinationBox = await destination.boundingBox();
      expect(destinationBox!.x).toBeGreaterThanOrEqual(0);
      expect(destinationBox!.x + destinationBox!.width).toBeLessThanOrEqual(390);
      expect(await page.evaluate(() => window.scrollX)).toBe(0);
      await page.keyboard.press("Escape");
      await composer.fill("A detailed plan for the next release.\n".repeat(20));
      expect(
        await composer.evaluate((element) => element.scrollHeight > element.clientHeight),
      ).toBe(true);
      await capture("long-prompt");
    });
  });

  it.each(["chat", "new"] as const)("opens the team composer directly from %s", async (route) => {
    await suite.withPage(mobile, async ({ page }) => {
      const gateway = await installScenario(page, undefined, true);
      const draft = "Help me plan the next release.";
      await page.goto(
        route === "chat"
          ? controlUiSessionUrl(suite.server.baseUrl, "agent:research:current")
          : suite.server.baseUrl + "new?agent=research",
      );
      await page
        .locator(
          route === "chat"
            ? ".agent-chat__composer-combobox textarea"
            : ".new-session-page__message",
        )
        .waitFor();
      if (route === "new") {
        await page.goto(suite.server.baseUrl + "sessions");
        await waitForControlUiRoute(page, { routeId: "sessions" });
        const create = page.getByRole("link", { name: "New conversation", exact: true });
        expect(await page.locator(".topbar .header-new-session").isVisible()).toBe(true);
        expect(await create.count()).toBe(1);
        expect(await create.getAttribute("href")).toBe("/new?agent=research");
        await create.focus();
        await page.keyboard.press("Enter");
        await waitForControlUiRoute(page, { routeId: "new-session", search: "?agent=research" });
        await page.locator(".new-session-page__message").fill(draft);
      } else {
        expect(await page.locator(".header-new-session").count()).toBe(0);
      }
      const dir =
        process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
          ? createControlUiE2eArtifactDir("mobile-team-" + route)
          : null;
      const capture = async (name: string) => {
        if (!dir) {
          return;
        }
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator(".shell"),
          [
            page
              .locator(
                ".agent-chat__header--mobile:visible, .header-new-session:visible, .new-session-page__composer:visible",
              )
              .first(),
          ],
          { animations: "disabled" },
        );
        await writeFile(path.join(dir, name + ".png"), frame.png);
      };
      await capture("closed");
      const action = page.getByRole("link", { name: "New conversation", exact: true });
      expect(await action.count()).toBe(0);
      // Mouse hover can reveal the sliding drawer's tooltip, which owns the first Escape.
      await navigationDrawerToggle(page).tap();
      await waitForMobileSidebarDrawerOpen(page);
      expect(await page.locator(".header-new-session:visible").count()).toBe(0);
      expect(await action.count()).toBe(1);
      expect(await action.getAttribute("href")).toBe("/new?agent=research");
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      expect(await page.locator(".sidebar-rail .sidebar-new-session").isVisible()).toBe(true);
      if (route === "new") {
        // The drawer moves focus after rendering; Escape must not reach the departing text field.
        await page.locator(".shell-nav:focus, .shell-nav :focus").waitFor();
        await page.keyboard.press("Escape");
        await page.locator(".shell--nav-drawer-open").waitFor({ state: "detached" });
        expect(await page.locator(".new-session-page__message").inputValue()).toBe(draft);
        // Without a topbar action on New Session, the drawer owns reopening it.
        await navigationDrawerToggle(page).tap();
        await waitForMobileSidebarDrawerOpen(page);
      }
      await action.tap();
      await waitForControlUiRoute(page, { routeId: "new-session", search: "?agent=research" });
      const composer = page.locator(".new-session-page__message");
      await composer.waitFor();
      // New Session is the action's destination, so its topbar omits the action.
      expect(await page.locator(".topbar .header-new-session").count()).toBe(0);
      if (route === "chat") {
        await expect
          .poll(() => composer.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await page.keyboard.type(draft);
      }
      // Reopening the current composer keeps its draft instead of resetting it.
      expect(await composer.inputValue()).toBe(draft);
      await capture("composer");
      const picker = page.locator(".new-session-page__select--agent openclaw-agent-select");
      await picker.locator(".agent-select__trigger").tap();
      await picker.getByRole("option", { name: "Scout", exact: true }).tap();
      await expect.poll(() => picker.locator(".agent-select__label").textContent()).toBe("Scout");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    });
  });

  it("shows the chat header while creating a session", async () => {
    await suite.withPage(mobile, async ({ page }) => {
      const gateway = await installScenario(page);
      await page.goto(suite.server.baseUrl + "new?agent=research");
      await page.locator(".new-session-page__message").fill("Help me plan the next release.");
      const toggle = navigationDrawerToggle(page);
      const appearance = () =>
        toggle.evaluate((element) => {
          const { width, border, backgroundColor } = getComputedStyle(element);
          return [width, border, backgroundColor, element.querySelector("path")?.getAttribute("d")];
        });
      const draft = await appearance();
      await gateway.deferNext("sessions.create");
      await page.locator(".new-session-page__start-submit").tap();
      const pending = page.locator("openclaw-pending-session-create");
      await pending.locator(".agent-chat__header--mobile").waitFor();
      expect(await pending.locator(".chat-pane__header").count()).toBe(0);
      const pendingAppearance = await appearance();
      await gateway.resolveDeferred("sessions.create");
      await pending.waitFor({ state: "detached" });
      // Draft topbar, pending header and admitted chat header present one control.
      expect([draft, pendingAppearance]).toEqual(Array(2).fill(await appearance()));
    });
  });

  it.each([
    { state: "denied", team: false },
    { state: "disconnected", team: false },
    { state: "denied", team: true },
  ] as const)(
    "keeps the $state creation action visible but non-navigable (team: $team)",
    async ({ state, team }) => {
      await suite.withPage(mobile, async ({ page }) => {
        const gateway = await installScenario(
          page,
          state === "denied" ? ["operator.read"] : undefined,
          team,
        );
        await page.goto(
          state === "denied"
            ? controlUiSessionUrl(suite.server.baseUrl, "agent:research:current")
            : suite.server.baseUrl + "sessions",
        );
        if (state === "denied") {
          await navigationDrawerToggle(page).tap();
          await waitForMobileSidebarDrawerOpen(page);
        }
        const create = page.locator(
          state === "denied" ? ".sidebar-rail .sidebar-new-session" : ".header-new-session",
        );
        await create.waitFor();
        if (state === "disconnected") {
          await gateway.setOnline(false);
          await gateway.closeLatest(1001, "mobile creation offline proof");
        }
        await expect.poll(() => create.isDisabled()).toBe(true);
        expect(await create.getAttribute("href")).toBeNull();
        expect(await create.getAttribute("aria-disabled")).toBe("true");
        expect(await create.getAttribute("tabindex")).toBe("-1");
        const location = page.url();
        await create.click({ force: true });
        expect(page.url()).toBe(location);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      });
    },
  );
});
