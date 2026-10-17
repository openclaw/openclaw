import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForMobileSidebarDrawerOpen } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mobile New conversation" });
const mobile = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  colorScheme: "dark" as const,
};
const currentSession = "agent:research:current";
const draft = "Help me plan the next release.";
const composerSelector = ".new-session-page__message";
const headerSelector = ".chat-pane__header:visible, .header-new-session:visible";
const drawerToggleSelector = ".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible";

function artifactDir(name: string) {
  return process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" ? createControlUiE2eArtifactDir(name) : null;
}

async function capture(
  page: Page,
  dir: string | null,
  name: string,
  content: Locator[] = [page.locator(headerSelector).first()],
  elementOnly = false,
) {
  if (!dir) {
    return;
  }
  const frame = await takeControlUiScreenshotFrame(page, page.locator(".shell"), content, {
    animations: "disabled",
    ...(elementOnly ? { elements: content } : {}),
  });
  await writeFile(path.join(dir, name + ".png"), elementOnly ? frame.elements[0]!.png : frame.png);
}

async function openComposer(page: Page, route: "chat" | "new") {
  await page.goto(
    route === "chat"
      ? controlUiSessionUrl(suite.server.baseUrl, currentSession)
      : suite.server.baseUrl + "new?agent=research",
  );
  await page
    .locator(route === "chat" ? ".agent-chat__composer-combobox textarea" : composerSelector)
    .waitFor();
}

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
    methodResponses: team
      ? {
          "agents.list": {
            defaultId: "research",
            mainKey: "main",
            scope: "per-sender",
            agents: [
              { id: "research", name: "Atlas" },
              { id: "writer", name: "Scout" },
            ],
          },
        }
      : undefined,
    agentModel: "demo/demo-model",
    models: [{ id: "demo-model", provider: "demo", name: "Demo model", contextWindow: 32000 }],
    sessionKey: currentSession,
    sessions: [{ key: currentSession, kind: "direct", label: "Launch planning" }],
    historyMessages: [
      ["user", "Review the launch."],
      ["assistant", "The release is ready."],
    ].map(([role, text]) => ({ role, content: [{ type: "text", text }] })),
  });
}

suite.define(() => {
  it("keeps creation in chat navigation and non-chat page headers", () =>
    suite.withPage(mobile, async ({ page }) => {
      const gateway = await installScenario(page);
      const dir = artifactDir("mobile-new-conversation-after");
      await openComposer(page, "chat");
      expect(await page.locator(".header-new-session").count()).toBe(0);
      await capture(page, dir, "chat");
      await page.locator(".chat-pane__nav-toggle").tap();
      await waitForMobileSidebarDrawerOpen(page);
      const create = page.getByRole("link", { name: "New conversation", exact: true });
      await create.waitFor();
      expect(await create.count()).toBe(1);
      expect(await create.getAttribute("href")).toBe("/new?agent=research");
      const box = await create.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      expect(await page.locator(".sidebar-rail .sidebar-new-session").isVisible()).toBe(true);
      await create.tap();
      await waitForControlUiRoute(page, { routeId: "new-session", search: "?agent=research" });
      await page.locator(composerSelector).waitFor();
      expect(await page.locator(".topbar .header-new-session").count()).toBe(1);
      await capture(page, dir, "topbar");
      await page.goto(suite.server.baseUrl + "agents");
      await waitForControlUiRoute(page, { routeId: "agents-home" });
      expect(await page.locator(".topbar .header-new-session").isVisible()).toBe(true);
      expect(await create.count()).toBe(1);
      expect(await create.getAttribute("href")).toBe("/new?agent=research");
      await create.focus();
      await page.keyboard.press("Enter");
      await waitForControlUiRoute(page, { routeId: "new-session" });
      expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe("/new?agent=research");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      if (dir) {
        await openComposer(page, "chat");
        await page.emulateMedia({ colorScheme: "light" });
        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("light");
        await capture(page, dir, "chat-light");
        await page.setViewportSize({ width: 1280, height: 800 });
        const sidebar = page.locator("openclaw-app-sidebar .sidebar");
        await capture(page, dir, "rail-light", [sidebar], true);
      }
    }));

  it("keeps the mobile welcome with its composer across phone and keyboard viewports", () =>
    suite.withPage(mobile, async ({ page }) => {
      await installScenario(page, undefined, true);
      await page.goto(suite.server.baseUrl + "new?agent=research");
      const composer = page.locator(composerSelector);
      await composer.fill(draft);
      const identity = page.locator(".new-session-page .agent-chat__welcome-identity");
      const triggers = page.locator(".new-session-page__triggers");
      const surface = page.locator(".new-session-page__composer");
      const agentLabel = page.locator(".new-session-page__select--agent .agent-select__label");
      const scroll = page.locator(".new-session-page__scroll");
      const dir = artifactDir("mobile-composer-layout");
      const content = [identity, triggers, surface];
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
        const frame = await takeControlUiScreenshotFrame(page, page.locator(".shell"), content, {
          animations: "disabled",
        });
        if (dir) {
          await writeFile(path.join(dir, state.name + ".png"), frame.png);
        }
        const heroBox = await identity.boundingBox();
        const targetBox = await triggers.boundingBox();
        const composerBox = await surface.boundingBox();
        expect([heroBox, targetBox, composerBox]).not.toContain(null);
        expect(targetBox!.y - heroBox!.y - heroBox!.height).toBeGreaterThanOrEqual(0);
        expect(targetBox!.y - heroBox!.y - heroBox!.height).toBeLessThanOrEqual(24);
        expect(heroBox!.y).toBeGreaterThanOrEqual(58);
        const compositionCenter = (heroBox!.y + composerBox!.y + composerBox!.height) / 2;
        const contentCenter = 58 + (state.height - 58) / 2;
        expect(Math.abs(compositionCenter - contentCenter)).toBeLessThanOrEqual(48);
        const local = page.locator("#new-session-where-trigger");
        expect((await local.boundingBox())!.width).toBeLessThanOrEqual(100);
        expect(await agentLabel.isVisible()).toBe(true);
        expect(composerBox!.height).toBeLessThanOrEqual(150);
        expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(state.height);
        expect(composerBox!.x).toBeGreaterThanOrEqual(0);
        expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(state.width);
        expect(await composer.inputValue()).toBe(draft);
        expect(await scroll.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await composer.fill("");
      expect(await page.locator(".new-session-page__start-submit").isDisabled()).toBe(true);
      await capture(page, dir, "empty", content);
      await page.locator("#new-session-where-trigger").tap();
      const destination = page.locator("#new-session-where-popover");
      await destination.waitFor();
      await capture(page, dir, "menu", [destination]);
      const destinationBox = await destination.boundingBox();
      expect(destinationBox!.x).toBeGreaterThanOrEqual(0);
      expect(destinationBox!.x + destinationBox!.width).toBeLessThanOrEqual(390);
      expect(await page.evaluate(() => window.scrollX)).toBe(0);
      await page.keyboard.press("Escape");
      await composer.fill("A detailed plan for the next release.\n".repeat(20));
      expect(await composer.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      await capture(page, dir, "long-prompt", content);
    }));

  it.each(["chat", "new"] as const)("opens the team composer directly from %s", (route) =>
    suite.withPage(mobile, async ({ page }) => {
      const gateway = await installScenario(page, undefined, true);
      await openComposer(page, route);
      if (route === "new") {
        await page.locator(composerSelector).fill(draft);
      }
      const dir = artifactDir("mobile-team-" + route);
      await capture(page, dir, "closed");
      const action = page.getByRole("link", { name: "New conversation", exact: true });
      expect(await action.count()).toBe(route === "chat" ? 0 : 1);
      // Mouse hover can reveal the sliding drawer's tooltip, which owns the first Escape.
      await page.locator(drawerToggleSelector).first().tap();
      await waitForMobileSidebarDrawerOpen(page);
      expect(await page.locator(".header-new-session:visible").count()).toBe(0);
      expect(await action.count()).toBe(1);
      if (route === "new") {
        // The drawer moves focus after rendering; Escape must not reach the departing text field.
        await page.locator(".shell-nav:focus, .shell-nav :focus").waitFor();
        await page.keyboard.press("Escape");
        await page.locator(".shell--nav-drawer-open").waitFor({ state: "detached" });
      }
      await action.tap();
      await waitForControlUiRoute(page, { routeId: "new-session", search: "?agent=research" });
      const composer = page.locator(composerSelector);
      await composer.waitFor();
      if (route === "chat") {
        await expect
          .poll(() => composer.evaluate((el) => el === document.activeElement))
          .toBe(true);
        await page.keyboard.type(draft);
      }
      // Reopening the current composer keeps its draft instead of resetting it.
      expect(await composer.inputValue()).toBe(draft);
      await capture(page, dir, "composer");
      const picker = page.locator(".new-session-page__select--agent openclaw-agent-select");
      await picker.locator(".agent-select__trigger").tap();
      await picker.getByRole("menuitemradio", { name: "Scout", exact: true }).tap();
      await expect.poll(() => picker.locator(".agent-select__label").textContent()).toBe("Scout");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    }),
  );

  it.each([
    { state: "denied", team: false },
    { state: "disconnected", team: false },
    { state: "denied", team: true },
  ] as const)("blocks $state creation (team: $team)", ({ state, team }) =>
    suite.withPage(mobile, async ({ page }) => {
      const gateway = await installScenario(
        page,
        state === "denied" ? ["operator.read"] : undefined,
        team,
      );
      await page.goto(
        state === "denied"
          ? controlUiSessionUrl(suite.server.baseUrl, currentSession)
          : suite.server.baseUrl + "new?agent=research",
      );
      if (state === "denied") {
        await page.locator(".chat-pane__nav-toggle").tap();
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
    }),
  );
});
