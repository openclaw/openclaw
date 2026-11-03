import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
} from "./session-management.test-support.ts";
import { expectAttribute } from "./sidebar-assertions.test-support.ts";
import { style } from "./sidebar-contract.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each([
    { theme: "light", touch: false },
    { theme: "dark", touch: false },
    { theme: "dark", touch: true },
  ] as const)(
    "keeps child toggles reachable by pointer and keyboard in chip mode ($theme, touch=$touch)",
    async ({ theme, touch }) => {
      await suite.withPage(
        { colorScheme: theme, hasTouch: touch, viewport: { width: 1280, height: 800 } },
        async ({ page }) => {
          const now = Date.UTC(2026, 9, 14, 12);
          const activeKey = "agent:main:main";
          const parentKey = "agent:main:dashboard:onboarding";
          const active = sessionRow(activeKey, "Home", now);
          const makeChild = (name: string, offset: number) =>
            sessionRow("agent:main:dashboard:" + name, name, now + offset, {
              spawnedBy: parentKey,
              status: undefined,
            });
          const children = ["oauth", "workboard"].map((name, index) => makeChild(name, index + 2));
          const childKeys = children.map((child) => child.key);
          const parent = sessionRow(parentKey, "Mac app onboarding flow testing", now + 1, {
            childSessions: childKeys,
          });
          await page.clock.install();
          await seedChatSettings(page, suite.server.baseUrl, {
            sidebarAgentsMode: "chip",
            themeMode: theme,
            navWidth: 320,
          });
          await installMockGateway(page, {
            sessionKey: activeKey,
            sessions: [active, parent, ...children],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, activeKey));
          const sidebar = page.locator("openclaw-app-sidebar");
          const row = sidebar.locator('[data-session-key="' + parentKey + '"]');
          const toggle = row.locator("[data-child-session-toggle]");
          await toggle.waitFor();
          if ((await toggle.getAttribute("aria-expanded")) === "false") {
            await toggle.click();
          }
          const child = sidebar.locator('[data-session-key="' + childKeys[0] + '"]');
          await child.waitFor();
          await page.mouse.click(1100, 700);
          if (captureUiProofEnabled) {
            const surface = page.locator(".shell-nav");
            await takeControlUiScreenshotFrame(page, surface, [row, child], {
              animations: "disabled",
              elements: [surface],
            });
          }
          expect(await style(toggle, "opacity")).toBe("1");
          expect(await style(toggle, "pointer-events")).not.toBe("none");
          const toggleBox = await toggle.boundingBox();
          const titleBox = await row.locator(".sidebar-recent-session__title-row").boundingBox();
          expect(toggleBox!.x).toBeGreaterThanOrEqual(titleBox!.x + titleBox!.width);
          expect(await toggle.textContent()).toContain("2");
          await toggle.click();
          await expectAttribute(toggle, "aria-expanded", "false");
          expect(await child.count()).toBe(0);
          await toggle.focus();
          await page.keyboard.press("Enter");
          await child.waitFor();
          expect(await toggle.getAttribute("aria-expanded")).toBe("true");
        },
      );
    },
  );
});
