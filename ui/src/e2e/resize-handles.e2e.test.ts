import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { SidebarDock } from "../pages/chat/sidebar-layout-types.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { dockChatSidePanel } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI resize handles",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:main";

async function seedSidePanel(page: Page, dock: SidebarDock = "right") {
  const key = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await page.addInitScript(
    ({ settingsKey, session, dock: initialDock }) => {
      localStorage.setItem(
        settingsKey,
        JSON.stringify({
          sessionKey: session,
          sidebarSessionLayouts: {
            [session]: {
              columns: [
                {
                  id: "side-panel-column",
                  side: "right",
                  panels: [{ id: "detail", slot: "detail" }],
                  activePanelId: "detail",
                  height: 320,
                  width: 420,
                },
              ],
              dock: initialDock,
              open: true,
              expanded: false,
            },
          },
        }),
      );
    },
    { settingsKey: key, session: sessionKey, dock },
  );
}

async function openSidePanel(page: Page, dock: SidebarDock = "right") {
  await seedSidePanel(page, dock);
  await installMockGateway(page, {
    featureMethods: ["sessions.diff"],
    methodResponses: {
      "sessions.diff": {
        additions: 0,
        deletions: 0,
        files: [],
        root: "/tmp/openclaw",
        sessionKey,
      },
    },
    sessionKey,
    workspace: "/tmp/openclaw",
    workspaceGit: true,
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  await waitForControlUiGatewayReady(page);
}

async function lineStyle(locator: Locator) {
  return locator.evaluate((element) => {
    const host = getComputedStyle(element);
    const line = getComputedStyle(element, "::after");
    return {
      color: line.backgroundColor,
      height: line.height,
      outline: host.outlineStyle,
      width: line.width,
    };
  });
}

async function waitForAnimations(locator: Locator) {
  await locator.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
  });
}

async function captureResizeState(page: Page, name: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const output = path.join(suite.artifactDir, "resize-handles");
  await page.screenshot({
    animations: "disabled",
    path: path.join(output, `${name}.png`),
  });
}

suite.define(() => {
  it.each([
    ["ltr", "left"],
    ["ltr", "right"],
    ["ltr", "bottom"],
    ["rtl", "left"],
    ["rtl", "right"],
    ["rtl", "bottom"],
  ] as const)(
    "follows physical pointer and arrow movement in %s with the %s dock",
    async (direction, dock) => {
      await suite.withPage(
        { locale: "en-US", viewport: { height: 760, width: 1440 } },
        async ({ page }) => {
          await openSidePanel(page, dock);
          await page.evaluate((value) => {
            document.documentElement.dir = value;
          }, direction);
          const divider = page.getByRole("separator", { name: "Resize side panel" });
          await divider.waitFor();
          const bounds = await divider.boundingBox();
          expect(bounds).not.toBeNull();
          const horizontal = dock === "bottom";
          const coordinate = async () => {
            const current = await divider.boundingBox();
            expect(current).not.toBeNull();
            return horizontal ? current!.y : current!.x;
          };
          const before = horizontal ? bounds!.y : bounds!.x;
          const x = bounds!.x + bounds!.width / 2;
          const y = bounds!.y + bounds!.height / 2;
          const delta = horizontal ? 50 : -80;
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(horizontal ? x : x + delta, horizontal ? y + delta : y, {
            steps: 4,
          });
          await page.mouse.up();
          await expect
            .poll(async () => Math.abs((await coordinate()) - (before + delta)))
            .toBeLessThanOrEqual(2);

          await divider.focus();
          const beforeForward = await coordinate();
          await page.keyboard.press(horizontal ? "ArrowDown" : "ArrowRight");
          await expect.poll(coordinate).toBeGreaterThan(beforeForward + 1);
          const beforeBackward = await coordinate();
          await page.keyboard.press(horizontal ? "ArrowUp" : "ArrowLeft");
          await expect.poll(coordinate).toBeLessThan(beforeBackward - 1);
        },
      );
    },
  );

  it("keeps navigation and side-panel handles aligned across input and dock states", async () => {
    await suite.withPage(
      { colorScheme: "dark", locale: "en-US", viewport: { height: 760, width: 1440 } },
      async ({ page }) => {
        await openSidePanel(page);

        const navigation = page.getByRole("separator", { name: "Resize sidebar" });
        const sidePanel = page.getByRole("separator", { name: "Resize side panel" });
        const shellNav = page.locator(".shell-nav");
        const panel = page.locator('[data-panel-slot="detail"]');
        await sidePanel.waitFor();

        const [navBounds, panelBounds, sideBounds] = await Promise.all([
          shellNav.boundingBox(),
          panel.boundingBox(),
          sidePanel.boundingBox(),
        ]);
        expect(navBounds).not.toBeNull();
        expect(panelBounds).not.toBeNull();
        expect(sideBounds).not.toBeNull();
        expect(Math.abs(sideBounds!.x + sideBounds!.width - panelBounds!.x)).toBeLessThanOrEqual(1);
        expect(
          await shellNav.evaluate((element) => getComputedStyle(element).borderInlineEndWidth),
        ).toBe("1px");
        expect((await lineStyle(navigation)).width).toBe("1px");
        expect((await lineStyle(sidePanel)).width).toBe("1px");
        await captureResizeState(page, "right-rest");

        await sidePanel.hover();
        await waitForAnimations(sidePanel);
        expect((await lineStyle(sidePanel)).width).toBe("2px");
        await captureResizeState(page, "right-hover");

        const pointerBounds = await sidePanel.boundingBox();
        await page.mouse.move(pointerBounds!.x + pointerBounds!.width / 2, pointerBounds!.y + 80);
        await page.mouse.down();
        await expect.poll(() => sidePanel.getAttribute("class")).toContain("dragging");
        expect(await sidePanel.evaluate((element) => element.matches(":focus-visible"))).toBe(
          false,
        );
        await captureResizeState(page, "right-pointer");
        await page.mouse.move(pointerBounds!.x - 20, pointerBounds!.y + 80);
        await page.mouse.up();

        await navigation.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        expect(await navigation.evaluate((element) => element.matches(":focus-visible"))).toBe(
          true,
        );
        expect((await lineStyle(navigation)).outline).not.toBe("none");
        await captureResizeState(page, "keyboard-focus");

        await dockChatSidePanel(page, "bottom");
        await expect.poll(() => sidePanel.getAttribute("orientation")).toBe("horizontal");
        expect((await lineStyle(sidePanel)).height).toBe("1px");
        await sidePanel.hover();
        await waitForAnimations(sidePanel);
        expect((await lineStyle(sidePanel)).height).toBe("2px");
        await captureResizeState(page, "bottom-hover");

        await page.setViewportSize({ height: 760, width: 900 });
        await expect.poll(() => navigation.isVisible()).toBe(false);
        await expect.poll(() => sidePanel.isVisible()).toBe(false);
      },
    );
  });
});
