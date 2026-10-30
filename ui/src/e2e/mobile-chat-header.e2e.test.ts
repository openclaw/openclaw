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
const title = "Seeing duplicate text in the session";

async function installFixture(page: Page, defaultWorkspace = false) {
  return installMockGateway(page, {
    sessionKey,
    workspace: "/local/workspace-main",
    presenceUsers: defaultWorkspace
      ? []
      : ["alex", "sam"].map((id) => ({
          id,
          identity: { type: "profile" as const, id },
          name: id,
          watchedSessions: [sessionKey],
        })),
    methodResponses: {
      "sessions.list": chatSessionListResponse([
        {
          key: sessionKey,
          kind: "direct",
          label: title,
          spawnedCwd: defaultWorkspace ? "/local/workspace-main" : "/repo/openclaw",
          updatedAt: 1,
          owner: {
            actor: {
              type: "human",
              id: "alex",
              label: "Alex",
              identity: { type: "profile", id: "alex" },
            },
          },
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
    await suite.withPage({ viewport: { width: 320, height: 700 } }, async ({ page }) => {
      const gateway = await installFixture(page);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const header = page.locator(".chat-pane-cache__pane--active .agent-chat__header--mobile");
      await header.getByRole("button", { name: title + " — Details", exact: true }).waitFor();
      await gateway.setOnline(false);
      await header.locator(".mobile-header__notices").waitFor();
      await header.locator(".chat-header-session-menu__trigger").waitFor();
      const offlineDetails = await openChatDetails(page);
      expect(
        await offlineDetails
          .getByRole("button", { name: "Details", exact: true })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      await closeChatDetails(page);
      const connectCount = await gateway.deferNext("connect");
      await gateway.setOnline(true);
      await gateway.waitForRequest("connect", { after: connectCount });
      const spinner = header.locator(".mobile-header__spinner");
      await spinner.waitFor();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect
        .poll(() => spinner.evaluate((element) => getComputedStyle(element).animationName))
        .toBe("none");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await expect
        .poll(() => spinner.evaluate((element) => getComputedStyle(element).animationName))
        .toBe("btn-spinner-spin");
      await gateway.resolveDeferred("connect");
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
    { width: 349, height: 700, colorScheme: "light" },
    { width: 350, height: 700, colorScheme: "light" },
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
          if (viewport.width >= 350) {
            await panels.waitFor();
          } else {
            expect(await panels.isVisible()).toBe(false);
          }
          const actions = header.locator(".chat-header-session-menu__trigger");
          await actions.waitFor();
          expect(
            await header.locator(".mobile-header__capsule").getByRole("button").allTextContents(),
          ).toHaveLength(viewport.width < 350 ? 1 : 2);
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
                  width: button.getBoundingClientRect().width,
                  height: button.getBoundingClientRect().height,
                })),
            };
          });
          expect(geometry.titleWidth).toBeGreaterThan(80);
          expect(geometry.actionsRight).toBeLessThanOrEqual(geometry.headerRight);
          expect(geometry.bodyWidth).toBe(geometry.viewportWidth);
          for (const button of geometry.buttons) {
            expect(button.width).toBeGreaterThanOrEqual(40);
            expect(button.height).toBeGreaterThanOrEqual(40);
          }

          const project = header.locator(".chat-pane__workspace-chip", { hasText: "openclaw" });
          await project.waitFor();
          expect(
            (await header.locator(".mobile-header__title-text").boundingBox())!.y,
          ).toBeLessThan((await project.boundingBox())!.y);
          await header.getByRole("button", { name: "People", exact: true }).waitFor();

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

          if (viewport.width < 350) {
            await actions.click();
            await page.getByRole("menuitem", { name: "Panels", exact: true }).click();
          } else {
            await panels.click();
          }
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
          // Threshold rows cover entry; 320, 390 and short-landscape rows retain the full journey.
          if (viewport.width === 349 || viewport.width === 350) {
            return;
          }
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
          if (viewport.width >= 350) {
            await panels.waitFor();
          }
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

  it("omits the fallback workspace label without losing mobile controls or desktop files", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      await installFixture(page, true);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const pane = page.locator(".chat-pane-cache__pane--active");
      const header = pane.locator(".agent-chat__header--mobile");
      await header.getByRole("button", { name: title + " — Details", exact: true }).waitFor();
      await header.getByRole("button", { name: "Panels", exact: true }).waitFor();
      expect(await header.getByRole("button", { name: "People", exact: true }).count()).toBe(0);
      expect(await header.locator(".chat-pane__workspace-chip").count()).toBe(0);
      await page.setViewportSize({ width: 1280, height: 900 });
      const desktop = pane.locator(".chat-pane__header");
      await desktop.getByRole("button", { name: "Details", exact: true }).waitFor();
      expect(await desktop.locator(".chat-pane__workspace-chip").count()).toBe(0);
    });
  });
});
