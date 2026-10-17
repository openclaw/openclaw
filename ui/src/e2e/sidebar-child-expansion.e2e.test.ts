import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each([
    { theme: "light", touch: false },
    { theme: "dark", touch: false },
    { theme: "dark", touch: true },
  ] as const)(
    "reveals new children without losing counts or manual collapse in chip mode ($theme, touch=$touch)",
    async ({ theme, touch }) => {
      await suite.withPage(
        { colorScheme: theme, hasTouch: touch, viewport: { width: 1280, height: 800 } },
        async ({ page }) => {
          const now = Date.UTC(2026, 9, 14, 12);
          const activeKey = "agent:main:main";
          const parentKey = "agent:main:dashboard:onboarding";
          const childKeys = ["agent:main:dashboard:oauth", "agent:main:dashboard:workboard"];
          const active = sessionRow(activeKey, "Home", now);
          const parent = sessionRow(parentKey, "Mac app onboarding flow testing", now + 1, {
            childSessions: childKeys,
          });
          const children = childKeys.map((key, index) =>
            sessionRow(
              key,
              ["Move OAuth profile persistence reads", "Land workboard archived-session recovery"][
                index
              ]!,
              now + 2 + index,
              {
                spawnedBy: parentKey,
                status: undefined,
              },
            ),
          );
          await page.clock.install();
          await page.addInitScript(
            ({ key, prefs }) => {
              localStorage.setItem(key, JSON.stringify(prefs));
            },
            {
              key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
              prefs: { sidebarAgentsMode: "chip", themeMode: theme, navWidth: 320 },
            },
          );
          const gateway = await installMockGateway(page, {
            sessionKey: activeKey,
            sessions: [active, parent, ...children],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, activeKey));
          const sidebar = page.locator("openclaw-app-sidebar");
          const row = sidebar.locator('[data-session-key="' + parentKey + '"]');
          const toggle = row.locator("[data-child-session-toggle]");
          await toggle.waitFor();
          // Both revisions show the same expanded content for the visual comparison.
          if ((await toggle.getAttribute("aria-expanded")) === "false") {
            await toggle.click();
          }
          const child = sidebar.locator('[data-session-key="' + childKeys[0] + '"]');
          await child.waitFor();
          await page.mouse.click(1100, 700);
          if (captureUiProofEnabled) {
            const surface = page.locator(".shell-nav");
            const frame = await takeControlUiScreenshotFrame(page, surface, [row, child], {
              animations: "disabled",
              elements: [surface],
            });
            await writeFile(
              path.join(suite.artifactDir, `children-expanded-chip-${theme}-touch-${touch}.png`),
              frame.elements[0]!.png,
            );
          }
          expect(await toggle.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
          expect(
            await toggle.evaluate((element) => getComputedStyle(element).pointerEvents),
          ).not.toBe("none");
          const toggleBox = await toggle.boundingBox();
          const titleBox = await row.locator(".sidebar-recent-session__title-row").boundingBox();
          expect(toggleBox!.x).toBeGreaterThanOrEqual(titleBox!.x + titleBox!.width);
          expect(await toggle.textContent()).toContain("2");
          await toggle.click();
          await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("false");
          const third = sessionRow(
            "agent:main:dashboard:verification",
            "Verify onboarding regression",
            now + 4,
            {
              spawnedBy: parentKey,
              status: undefined,
            },
          );
          await gateway.setSessionsListResponse(
            sessionsListResponse([
              active,
              { ...parent, childSessions: [...childKeys, third.key] },
              ...children,
              third,
            ]),
          );
          await pauseVirtualClock(page);
          await gateway.emitGatewayEvent("sessions.changed", {
            sessionKey: parentKey,
            agentId: "main",
            reason: "create",
            updatedAt: now + 4,
          });
          await page.clock.fastForward(5_001);
          await page.clock.resume();
          await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
          await sidebar.locator('[data-session-key="' + third.key + '"]').waitFor();
          await toggle.click();
          await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("false");
          await pauseVirtualClock(page);
          await gateway.emitGatewayEvent("sessions.changed", {
            sessionKey: parentKey,
            agentId: "main",
            reason: "patch",
            updatedAt: now + 5,
          });
          await page.clock.fastForward(5_001);
          await page.clock.resume();
          expect(await toggle.getAttribute("aria-expanded")).toBe("false");
          expect(await sidebar.locator('[data-session-key="' + third.key + '"]').count()).toBe(0);
          await toggle.focus();
          await page.keyboard.press("Enter");
          await sidebar.locator('[data-session-key="' + third.key + '"]').waitFor();
          expect(await toggle.getAttribute("aria-expanded")).toBe("true");
        },
      );
    },
  );
});
