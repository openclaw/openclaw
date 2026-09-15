import type { Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { openSessionMenuSubmenu, waitForPatch } from "./session-management.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Home pin customization" });

async function openPinEditor(page: Page) {
  const sidebar = page.locator("openclaw-app-sidebar");
  await sidebar.locator(".sidebar-nav__head-action").click();
  await sidebar.getByRole("menuitem", { name: "Edit pinned items" }).click();
  return sidebar.locator(".sidebar-pin-editor-menu");
}

suite.define(() => {
  it("unpins Home, groups the same conversation, and restores its shortcut without losing metadata", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const mainKey = "agent:main:main";
        const gateway = await installMockGateway(page, {
          sessionKey: mainKey,
          sessions: [
            sessionRow(mainKey, "Main conversation", Date.now()),
            sessionRow("agent:main:project", "Project planning", Date.now() - 60_000, {
              category: "Projects",
            }),
          ],
          sessionGroups: ["Projects"],
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Your conversation stays here." }],
            },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, mainKey));
        const sidebar = page.locator("openclaw-app-sidebar");
        const home = sidebar.locator(".nav-item--home");
        const main = sidebar.locator(`.sidebar-recent-session[data-session-key="${mainKey}"]`);
        await expect.poll(() => home.isVisible()).toBe(true);
        await expect.poll(() => main.count()).toBe(0);
        await captureSidebarUiProof(suite, page, "01-home-pinned.png");
        let editor = await openPinEditor(page);
        await editor.getByRole("menuitemcheckbox", { name: "Home", exact: true }).click();
        await page.keyboard.press("Escape");
        await expect.poll(() => home.count()).toBe(0);
        await expect.poll(() => main.isVisible()).toBe(true);
        await page.reload();
        await expect.poll(() => main.isVisible()).toBe(true);
        expect(await home.count()).toBe(0);
        await main.hover();
        await main.getByRole("button", { name: "Open session menu" }).click();
        await openSessionMenuSubmenu(page, "Move to group");
        await page.getByRole("menuitemradio", { name: /^Projects/ }).click();
        await waitForPatch(
          gateway,
          (params) => params.key === mainKey && params.category === "Projects",
        );
        const grouped = sidebar.locator(
          `[data-session-section="category:Projects"] .sidebar-recent-session[data-session-key="${mainKey}"]`,
        );
        await expect.poll(() => grouped.isVisible()).toBe(true);
        await captureSidebarUiProof(suite, page, "02-home-unpinned-grouped.png");
        editor = await openPinEditor(page);
        await editor.getByRole("menuitemcheckbox", { name: "Home", exact: true }).click();
        await page.keyboard.press("Escape");
        await expect.poll(() => home.isVisible()).toBe(true);
        await expect.poll(() => main.count()).toBe(0);
        editor = await openPinEditor(page);
        await editor.getByRole("menuitemcheckbox", { name: "Home", exact: true }).click();
        await page.keyboard.press("Escape");
        await expect.poll(() => grouped.isVisible()).toBe(true);
        await expect
          .poll(() => page.getByText("Your conversation stays here.", { exact: true }).isVisible())
          .toBe(true);
        editor = await openPinEditor(page);
        await editor.getByRole("menuitem", { name: "Reset pinned items", exact: true }).click();
        await expect.poll(() => home.isVisible()).toBe(true);
        await expect.poll(() => main.count()).toBe(0);
        for (const method of ["sessions.delete", "sessions.reset", "sessions.archive"]) {
          expect(await gateway.getRequests(method)).toHaveLength(0);
        }
      },
    );
  });
  it.each([true, false])(
    "keeps main children reachable when the main row is loaded=%s",
    async (parentLoaded) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, locale: "en-US", serviceWorkers: "block" },
        async ({ page }) => {
          const mainKey = "agent:main:main";
          const childKey = "agent:main:child";
          const activeKey = "agent:main:project";
          await installMockGateway(page, {
            sessionKey: activeKey,
            sessions: [
              ...(parentLoaded ? [sessionRow(mainKey, "Main conversation", Date.now())] : []),
              sessionRow(activeKey, "Project planning", Date.now()),
              sessionRow(childKey, "Child conversation", Date.now(), { spawnedBy: mainKey }),
            ],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, activeKey));
          const sidebar = page.locator("openclaw-app-sidebar");
          const child = sidebar.locator(`.sidebar-recent-session[data-session-key="${childKey}"]`);
          await expect.poll(() => child.isVisible()).toBe(true);
          const editor = await openPinEditor(page);
          await editor.getByRole("menuitemcheckbox", { name: "Home", exact: true }).click();
          await page.keyboard.press("Escape");
          if (parentLoaded) {
            const toggle = sidebar.locator(`[data-child-session-toggle="${mainKey}"]`);
            await expect.poll(() => toggle.isVisible()).toBe(true);
            if ((await toggle.getAttribute("aria-expanded")) === "false") {
              await toggle.click();
            }
          }
          await expect.poll(() => child.isVisible()).toBe(true);
          expect(await child.count()).toBe(1);
        },
      );
    },
  );

  it.each([
    { mainSessionKey: "global", sessionScope: "global" as const },
    { mainSessionKey: "agent:research:primary", defaultAgentId: "research" },
  ])("uses the advertised Home identity $mainSessionKey", async (identity) => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const key = identity.mainSessionKey;
        const agentId = identity.defaultAgentId ?? "main";
        await installMockGateway(page, {
          ...identity,
          sessionKey: key,
          sessions: [
            {
              ...sessionRow(key, "Main conversation", Date.now()),
              agentId,
              kind: key === "global" ? "global" : "direct",
            },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const sidebar = page.locator("openclaw-app-sidebar");
        await expect.poll(() => sidebar.locator(".nav-item--home").isVisible()).toBe(true);
        const editor = await openPinEditor(page);
        await editor.getByRole("menuitemcheckbox", { name: "Home", exact: true }).click();
        await page.keyboard.press("Escape");
        const main = sidebar.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
        await expect.poll(() => main.isVisible()).toBe(true);
        expect(await main.count()).toBe(1);
      },
    );
  });
});
