import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

async function expectSeparateControls(row: Locator, mobile: boolean) {
  const action = row.locator(
    mobile ? ".session-action--touch-menu" : "[data-sidebar-session-archive]",
  );
  const toggle = row.locator("[data-child-session-toggle]");
  const actionBounds = await row.locator(".session-row-actions").boundingBox();
  const toggleBounds = await toggle.boundingBox();
  expect(actionBounds).not.toBeNull();
  expect(toggleBounds).not.toBeNull();
  expect(
    Math.min(actionBounds!.x + actionBounds!.width, toggleBounds!.x + toggleBounds!.width) -
      Math.max(actionBounds!.x, toggleBounds!.x),
  ).toBeLessThanOrEqual(0);
  await expect
    .poll(() => action.evaluate((element) => getComputedStyle(element).opacity))
    .toBe("1");
}

suite.define(() => {
  it.each([
    { theme: "dark", navWidth: 320, touch: false, mobile: false },
    { theme: "light", navWidth: 240, touch: false, mobile: false },
    { theme: "light", navWidth: 320, touch: true, mobile: false },
    { theme: "dark", navWidth: 320, touch: true, mobile: true },
  ] as const)(
    "separates nested disclosure and archive controls ($theme, $navWidth, touch=$touch, mobile=$mobile)",
    async ({ theme, navWidth, touch, mobile }) => {
      await suite.withPage(
        {
          colorScheme: theme,
          hasTouch: touch,
          viewport: { width: mobile ? 390 : 1280, height: 800 },
        },
        async ({ page }) => {
          const now = Date.UTC(2026, 10, 4, 10);
          const activeKey = "agent:main:main";
          const keys = ["release", "verification", "sidebar", "screenshots"].map(
            (name) => "agent:main:dashboard:" + name,
          );
          const labels = [
            "Release readiness",
            "Verify sidebar interactions",
            "Nested session controls",
            "Capture review screenshots",
          ];
          const sessions = keys.map((key, index) =>
            sessionRow(key, labels[index]!, now + index, {
              ...(index === 0 && touch && !mobile
                ? { lastMessagePreview: "Checking sidebar controls" }
                : {}),
              ...(index > 0 ? { spawnedBy: keys[index - 1] } : {}),
              ...(keys[index + 1] ? { childSessions: [keys[index + 1]!] } : {}),
            }),
          );
          await seedChatSettings(page, suite.server.baseUrl, {
            sidebarAgentsMode: "chip",
            themeMode: theme,
            navWidth,
          });
          if (touch && !mobile) {
            await page.addInitScript(() =>
              localStorage.setItem("openclaw:sidebar:sessions:show-preview", "true"),
            );
          }
          await installMockGateway(page, {
            sessionKey: activeKey,
            sessions: [sessionRow(activeKey, "Home", now), ...sessions],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, activeKey));
          if (mobile) {
            await navigationDrawerToggle(page).click();
          }
          const sidebar = page.locator("openclaw-app-sidebar");
          const rowFor = (key: string) => sidebar.locator('[data-session-key="' + key + '"]');
          for (const key of keys.slice(0, -1)) {
            const row = rowFor(key);
            const toggle = row.locator("[data-child-session-toggle]");
            await toggle.waitFor();
            if ((await toggle.getAttribute("aria-expanded")) !== "true") {
              await toggle.focus();
              await page.keyboard.press("Enter");
            }
          }
          await rowFor(keys[3]!).waitFor();
          if (touch && !mobile) {
            expect(await rowFor(keys[0]!).getAttribute("class")).not.toContain(
              "sidebar-recent-session--single-line",
            );
          }
          {
            const row = rowFor(keys[2]!);
            await row.hover();
            if (captureUiProofEnabled) {
              const surface = page.locator(".shell-nav");
              const frame = await takeControlUiScreenshotFrame(page, surface, [row], {
                animations: "disabled",
                elements: [surface],
              });
              const name =
                theme + "-chip-" + navWidth + (touch ? "-touch" : "") + (mobile ? "-mobile" : "");
              await writeFile(path.join(suite.artifactDir, name + "-page.png"), frame.png);
              await writeFile(
                path.join(suite.artifactDir, name + "-sidebar.png"),
                frame.elements[0]!.png,
              );
              console.log(
                "Nested controls screenshot:",
                path.join(suite.artifactDir, name + "-sidebar.png"),
              );
            }
          }
          for (const [depth, key] of keys.slice(0, -1).entries()) {
            const row = rowFor(key);
            const toggle = row.locator("[data-child-session-toggle]");
            await row.hover();
            await expectSeparateControls(row, mobile);
            await toggle.click();
            expect(await toggle.getAttribute("aria-expanded")).toBe("false");
            await expectSeparateControls(row, mobile);
            await page.mouse.move(900, 700);
            await toggle.focus();
            await expectSeparateControls(row, mobile);
            await page.keyboard.press("Enter");
            await rowFor(keys[depth + 1]!).waitFor();
            expect(await toggle.getAttribute("aria-expanded")).toBe("true");
            await expectSeparateControls(row, mobile);
          }
        },
      );
    },
  );
});
