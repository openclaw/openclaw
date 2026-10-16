import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:mobile-header";
const title = "Mobile header redesign";

async function capture(page: Page, header: Locator, name: string, content: Locator[] = []) {
  if (!captureUiProofEnabled) {
    return;
  }
  const frame = await takeControlUiScreenshotFrame(page, header, [header, ...content], {
    animations: "disabled",
    elements: [header],
  });
  await writeFile(path.join(suite.artifactDir, name + ".png"), frame.png);
  await writeFile(path.join(suite.artifactDir, name + "-header.png"), frame.elements[0]!.png);
}

async function installFixture(page: Page) {
  await installMockGateway(page, {
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
  it("opens Details when its offline trigger retires during the click", async () => {
    await suite.withPage({ viewport: { width: 560, height: 900 } }, async ({ page }) => {
      page.setDefaultTimeout(1_000);
      await page.setContent("<button id=offline>Details</button>");
      await page.evaluate(() => {
        const offline = document.getElementById("offline")!;
        offline.addEventListener(
          "pointerover",
          () => {
            const menu = document.createElement("button");
            menu.className = "chat-header-session-menu__trigger";
            menu.textContent = "Actions";
            menu.addEventListener("click", () => {
              const item = document.createElement("button");
              item.setAttribute("role", "menuitem");
              item.textContent = "Session details";
              item.addEventListener("click", () => {
                const details = document.createElement("aside");
                details.setAttribute("role", "complementary");
                details.setAttribute("aria-label", "Details");
                details.textContent = "Session details content";
                document.body.append(details);
                item.remove();
              });
              document.body.append(item);
            });
            offline.replaceWith(menu);
          },
          { once: true },
        );
      });
      const details = await openChatDetails(page);
      expect(await details.textContent()).toBe("Session details content");
    });
  });

  for (const viewport of [
    { width: 390, height: 844, colorScheme: "light" },
    { width: 320, height: 700, colorScheme: "dark" },
    { width: 852, height: 393, colorScheme: "light" },
  ] as const) {
    it(`keeps two mobile toolbar actions at ${viewport.width}px`, async () => {
      const context = await suite.newBrowserContext({
        colorScheme: viewport.colorScheme,
        hasTouch: true,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: viewport.width, height: viewport.height },
      });
      const page = await context.newPage();
      await installFixture(page);
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const header = page.locator(".chat-pane-cache__pane--active .chat-pane__header");
        await header.locator(".chat-pane__session-title-text", { hasText: title }).waitFor();
        await capture(page, header, "mobile-header-" + viewport.width);
        const panels = header.getByRole("button", { name: "Panels", exact: true });
        await panels.waitFor();
        expect(
          await header.locator(".chat-pane__actions").getByRole("button").allTextContents(),
        ).toHaveLength(2);
        expect(await header.locator(".header-new-session").count()).toBe(0);
        expect(await header.getByRole("button", { name: "Details", exact: true }).count()).toBe(0);
        const geometry = await header.evaluate((element) => {
          const titleText = element.querySelector(".chat-pane__session-title-text")!;
          const actions = element.querySelector(".chat-pane__actions")!;
          return {
            titleWidth: titleText.getBoundingClientRect().width,
            headerRight: element.getBoundingClientRect().right,
            actionsRight: actions.getBoundingClientRect().right,
            bodyWidth: document.documentElement.scrollWidth,
            viewportWidth: innerWidth,
            buttons: Array.from(
              element.querySelectorAll<HTMLButtonElement>(
                ".chat-pane__nav-toggle, .chat-pane__actions button",
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
          "Actions for " + title,
          "Panels",
        ]);
        for (const button of geometry.buttons) {
          expect(button.width).toBeGreaterThanOrEqual(44);
          expect(button.height).toBeGreaterThanOrEqual(44);
        }

        const menu = header.locator(".chat-panel-layout-menu");
        const actions = header.locator(".chat-header-session-menu__trigger");
        await actions.click();
        await page.getByRole("menuitem", { name: "Session details", exact: true }).click();
        const details = page.getByRole("dialog", { name: "Details", exact: true });
        await details.waitFor();
        const detailsBox = await details.boundingBox();
        expect(detailsBox!.width).toBeGreaterThanOrEqual(viewport.width - 32);
        await capture(page, header, "mobile-details-" + viewport.width, [details]);
        await page.keyboard.press("Escape");
        await details.waitFor({ state: "hidden" });
        expect(await actions.evaluate((element) => element === document.activeElement)).toBe(true);

        await panels.click();
        await menu
          .getByRole("menuitemcheckbox", { name: "Show session files", exact: true })
          .click();
        const files = page.locator('[data-panel-slot="workspace"]:not([hidden])');
        await files
          .locator(".chat-workspace-rail__file-name", { hasText: "README.md" })
          .first()
          .waitFor();
        expect((await files.boundingBox())!.width).toBeGreaterThanOrEqual(viewport.width - 24);
        await capture(page, header, "mobile-files-" + viewport.width, [files]);
        await actions.click();
        await page.getByRole("menuitem", { name: "Session details", exact: true }).click();
        await details.waitFor();
        expect(await files.isVisible()).toBe(true);
        expect((await details.boundingBox())!.width).toBeGreaterThanOrEqual(viewport.width - 32);
        await capture(page, header, "mobile-files-details-" + viewport.width, [files, details]);
        await page.keyboard.press("Escape");
        await details.waitFor({ state: "hidden" });
        await page.setViewportSize({ width: 1280, height: 900 });
        await header.getByRole("button", { name: "Layout", exact: true }).waitFor();
        await expect.poll(async () => (await files.boundingBox())!.width).toBeLessThan(800);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await panels.waitFor();
        await expect
          .poll(async () => (await files.boundingBox())!.width)
          .toBeGreaterThanOrEqual(viewport.width - 24);
        await page.getByRole("button", { name: "Close Files", exact: true }).click();

        await header.getByRole("button", { name: "Actions for " + title, exact: true }).click();
        const sessionMenu = header.locator("openclaw-chat-header-session-menu");
        await sessionMenu.getByRole("menuitem", { name: "Rename…", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await header.locator(".chat-pane__nav-toggle").click();
        await page.getByRole("link", { name: "New conversation", exact: true }).waitFor();
      } finally {
        await suite.closeBrowserContext(context);
      }
    });
  }

  it("preserves desktop Layout and Details controls", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await installFixture(page);
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const header = page.locator(".chat-pane-cache__pane--active .chat-pane__header");
      await header.getByRole("button", { name: "Layout", exact: true }).waitFor();
      await header.getByRole("button", { name: "Details", exact: true }).waitFor();
      expect(await header.getByRole("button", { name: "Panels", exact: true }).count()).toBe(0);
      await capture(page, header, "desktop-header");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
