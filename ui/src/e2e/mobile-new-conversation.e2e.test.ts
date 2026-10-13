import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
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
        model: "demo-model",
        modelProvider: "demo",
        updatedAt: 1791871200000,
      },
    ],
    historyMessages: [
      { role: "user", content: [{ type: "text", text: "Let's review the launch checklist." }] },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "The release notes and design review are ready. What would you like to work on next?",
          },
        ],
      },
    ],
  });
}

suite.define(() => {
  it("keeps one reachable creation action in chat and page headers without opening the drawer", async () => {
    await suite.withPage(mobile, async ({ page }) => {
      const gateway = await installScenario(page);
      const dir =
        process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
          ? createControlUiE2eArtifactDir("mobile-new-conversation-after")
          : null;
      const capture = async (name: string) => {
        if (!dir) {
          return;
        }
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator(".shell"),
          [page.locator(".header-new-session:visible")],
          { animations: "disabled" },
        );
        await writeFile(path.join(dir, name + ".png"), frame.png);
      };
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:research:current"));
      await page.locator(".agent-chat__composer-combobox textarea").waitFor();
      const create = page.getByRole("link", { name: "New conversation", exact: true });
      await create.waitFor();
      expect(await create.count()).toBe(1);
      expect(await create.getAttribute("href")).toBe("/new?agent=research");
      const box = await create.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      await capture("chat");
      await page.locator(".chat-pane__nav-toggle").click();
      await page.locator(".shell--nav-drawer-open").waitFor();
      expect(await page.locator(".header-new-session").count()).toBe(0);
      expect(await create.count()).toBe(1);
      expect(await page.locator(".sidebar-rail .sidebar-new-session").isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      await page.locator(".shell--nav-drawer-open").waitFor({ state: "detached" });
      await create.tap();
      await waitForControlUiRoute(page, { routeId: "new-session", search: "?agent=research" });
      await page.locator(".new-session-page__message").waitFor();
      expect(await page.locator(".topbar .header-new-session").count()).toBe(1);
      await capture("topbar");
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
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:research:current"));
        await page.locator(".agent-chat__composer-combobox textarea").waitFor();
        await page.emulateMedia({ colorScheme: "light" });
        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("light");
        await capture("chat-light");
        await page.setViewportSize({ width: 1280, height: 800 });
        const sidebar = page.locator("openclaw-app-sidebar .sidebar");
        const frame = await takeControlUiScreenshotFrame(page, page.locator(".shell"), [sidebar], {
          animations: "disabled",
          elements: [sidebar],
        });
        await writeFile(path.join(dir, "rail-light.png"), frame.elements[0]!.png);
      }
    });
  });

  it.each(["chat", "new"] as const)(
    "keeps the team agent picker in the closed-drawer %s header",
    async (route) => {
      await suite.withPage(mobile, async ({ page }) => {
        const gateway = await installScenario(page, undefined, true);
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
            [page.locator(".header-new-session:visible")],
            { animations: "disabled" },
          );
          await writeFile(path.join(dir, name + ".png"), frame.png);
        };
        await capture("closed");
        const action = page.getByRole("button", { name: "New conversation", exact: true });
        expect(await action.count()).toBe(1);
        expect(
          await page.getByRole("link", { name: "New conversation", exact: true }).count(),
        ).toBe(0);
        await page
          .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
          .first()
          .click();
        await page.locator(".shell--nav-drawer-open").waitFor();
        expect(await page.locator(".header-new-session:visible").count()).toBe(0);
        expect(await action.count()).toBe(1);
        await page.keyboard.press("Escape");
        await page.locator(".shell--nav-drawer-open").waitFor({ state: "detached" });
        await action.tap();
        const menu = page.locator(".sidebar-new-session-menu:visible");
        await menu.locator('wa-dropdown-item[value="writer"]').waitFor();
        expect(
          await menu
            .locator("wa-dropdown-item a")
            .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
        ).toEqual(["/new?agent=research", "/new?agent=writer"]);
        await capture("agent-menu");
        await menu.locator('wa-dropdown-item[value="writer"]').click();
        await waitForControlUiRoute(page, { routeId: "new-session", search: "?agent=writer" });
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      });
    },
  );

  it.each([
    { state: "denied", team: false },
    { state: "disconnected", team: false },
    { state: "denied", team: true },
  ] as const)(
    "keeps the $state header action visible but non-navigable (team: $team)",
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
            : suite.server.baseUrl + "new?agent=research",
        );
        const create = page.locator(".header-new-session");
        await create.waitFor();
        if (state === "disconnected") {
          await gateway.setOnline(false);
          await gateway.closeLatest(1001, "mobile creation offline proof");
        }
        await expect.poll(() => create.isDisabled()).toBe(true);
        expect(await create.getAttribute("href")).toBeNull();
        if (!team) {
          expect(await create.getAttribute("aria-disabled")).toBe("true");
          expect(await create.getAttribute("tabindex")).toBe("-1");
        }
        const location = page.url();
        await create.click({ force: true });
        expect(page.url()).toBe(location);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      });
    },
  );
});
