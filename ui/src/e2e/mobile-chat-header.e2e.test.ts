import type { Page } from "playwright";
import { expect, it } from "vitest";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:mobile-header";
const title = "Mobile header redesign";

async function installFixture(page: Page) {
  return installMockGateway(page, {
    sessionKey,
    methodResponses: {
      "sessions.list": chatSessionListResponse([
        {
          key: sessionKey,
          kind: "direct",
          label: title,
          spawnedCwd: "/repo/openclaw",
          updatedAt: 1,
          owner: { actor: { type: "human", id: "alex", label: "Alex" } },
        },
      ]),
      "sessions.files.list": {
        sessionKey,
        root: "/repo/openclaw",
        files: [{ kind: "modified", name: "README.md", path: "/repo/openclaw/README.md" }],
        browser: { path: "", entries: [{ kind: "file", name: "README.md", path: "README.md" }] },
      },
    },
  });
}

suite.define(() => {
  it("opens native Details while disconnected and after reconnecting", async () => {
    await suite.withPage({ viewport: { width: 560, height: 900 } }, async ({ page }) => {
      const gateway = await installFixture(page);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const header = page.locator(".chat-pane-cache__pane--active .agent-chat__header--mobile");
      await header.getByRole("button", { name: title + " — Details", exact: true }).waitFor();
      await gateway.setOnline(false);
      await header.locator(".mobile-header__notices").waitFor();
      const offlineDetails = await openChatDetails(page);
      expect(
        await offlineDetails
          .getByRole("button", { name: "Details", exact: true })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      await closeChatDetails(page);
      await gateway.setOnline(true);
      await expect.poll(() => header.locator(".mobile-header__notices").isVisible()).toBe(false);
      const reconnectedDetails = await openChatDetails(page);
      expect(
        await reconnectedDetails
          .getByRole("button", { name: "Details", exact: true })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      await closeChatDetails(page);
    });
  });

  for (const viewport of [
    { width: 390, height: 844, colorScheme: "light" },
    { width: 320, height: 700, colorScheme: "dark" },
    { width: 852, height: 393, colorScheme: "light" },
  ] as const) {
    it(`keeps native mobile header actions at ${viewport.width}px`, async () => {
      await suite.withPage(
        {
          colorScheme: viewport.colorScheme,
          hasTouch: true,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: viewport.width, height: viewport.height },
        },
        async ({ page }) => {
          await installFixture(page);
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          const header = page.locator(".chat-pane-cache__pane--active .agent-chat__header--mobile");
          await header.locator(".mobile-header__title-text", { hasText: title }).waitFor();
          const panels = header.getByRole("button", { name: "Panels", exact: true });
          await panels.waitFor();
          const actions = header.locator(".chat-header-session-menu__trigger");
          await actions.waitFor();
          expect(
            await header.locator(".mobile-header__capsule").getByRole("button").allTextContents(),
          ).toHaveLength(2);
          expect(await header.locator(".header-new-session").count()).toBe(0);
          expect(await header.getByRole("button", { name: "Details", exact: true }).count()).toBe(
            0,
          );
          const geometry = await header.evaluate((element) => {
            const titleText = element.querySelector(".mobile-header__title-text")!;
            const capsule = element.querySelector(".mobile-header__capsule")!;
            return {
              titleWidth: titleText.getBoundingClientRect().width,
              headerRight: element.getBoundingClientRect().right,
              actionsRight: capsule.getBoundingClientRect().right,
              bodyWidth: document.documentElement.scrollWidth,
              viewportWidth: innerWidth,
              buttons: Array.from(
                element.querySelectorAll<HTMLButtonElement>(
                  ".mobile-header__navigation, .mobile-header__capsule button",
                ),
              )
                .filter((button) => button.checkVisibility())
                .map((button) => ({
                  label: button.getAttribute("aria-label"),
                  width: button.getBoundingClientRect().width,
                  height: button.getBoundingClientRect().height,
                })),
            };
          });
          expect(geometry.titleWidth).toBeGreaterThan(80);
          expect(geometry.actionsRight).toBeLessThanOrEqual(geometry.headerRight);
          expect(geometry.bodyWidth).toBe(geometry.viewportWidth);
          expect(geometry.buttons.map((button) => button.label)).toEqual([
            "Expand sidebar",
            "Panels",
            "Actions for " + title,
          ]);
          for (const button of geometry.buttons) {
            expect(button.width).toBeGreaterThanOrEqual(40);
            expect(button.height).toBeGreaterThanOrEqual(40);
          }

          const details = await openChatDetails(page);
          expect((await details.boundingBox())!.width).toBeGreaterThanOrEqual(viewport.width - 24);
          await details.getByRole("button", { name: "Details", exact: true }).focus();
          await page.keyboard.press("Escape");
          await details.waitFor({ state: "hidden" });
          expect(
            await header
              .locator(".mobile-header__title")
              .evaluate((element) => element === document.activeElement),
          ).toBe(true);

          await panels.click();
          const host = page.locator(".chat-pane-cache__pane--active .chat-mobile-host");
          await host.getByRole("button", { name: "Panels", exact: true }).click();
          await host
            .locator(".chat-panel-launcher-mobile")
            .getByRole("button", { name: "Files", exact: true })
            .click();
          const files = page.locator('[data-panel-slot="workspace"]:not([hidden])');
          await files
            .locator(".chat-workspace-mobile__name", { hasText: "README.md" })
            .first()
            .waitFor();
          expect((await files.boundingBox())!.width).toBeGreaterThanOrEqual(viewport.width - 24);
          const filesRoot = await files.elementHandle();
          await openChatDetails(page);
          expect(await files.isVisible()).toBe(false);
          expect(await filesRoot?.evaluate((element) => element.isConnected)).toBe(true);
          await host.getByRole("button", { name: "Panels", exact: true }).click();
          await files.waitFor();

          await page.setViewportSize({ width: 1280, height: 900 });
          await page
            .locator(".chat-pane-cache__pane--active .chat-pane__header")
            .locator(".chat-header-session-menu__trigger")
            .waitFor();
          await expect.poll(async () => (await files.boundingBox())!.width).toBeLessThan(800);
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await panels.waitFor();
          await expect
            .poll(async () => (await files.boundingBox())!.width)
            .toBeGreaterThanOrEqual(viewport.width - 24);
          expect(await filesRoot?.evaluate((element) => element.isConnected)).toBe(true);
          await filesRoot?.dispose();
          await host.getByRole("button", { name: "Close Files", exact: true }).click();
          await host.waitFor({ state: "hidden" });

          await actions.click();
          await page.getByRole("menuitem", { name: "Rename", exact: true }).waitFor();
          await page.keyboard.press("Escape");
          await header.locator(".mobile-header__navigation").click();
          await page.getByRole("link", { name: "New conversation", exact: true }).waitFor();
        },
      );
    });
  }

  it("preserves native desktop Actions, Details and frame Panels controls", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
      },
      async ({ page }) => {
        await installFixture(page);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const header = page.locator(".chat-pane-cache__pane--active .chat-pane__header");
        await header.locator(".chat-header-session-menu__trigger").waitFor();
        await header.getByRole("button", { name: "Details", exact: true }).waitFor();
        const panels = page
          .locator(".chat-pane-cache__pane--active .sidebar-region__panels-toggle")
          .getByRole("button", { name: "Panels", exact: true });
        expect(await panels.count()).toBe(1);
        expect(await panels.isVisible()).toBe(true);
      },
    );
  });
});
