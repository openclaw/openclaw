import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { createControlUiMockSameOriginGatewayScript } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  openSessionMenuSubmenu,
  waitForPatch,
  waitForMobileSidebarDrawerOpen,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const expectFocus = (target: Locator) =>
  expect.poll(() => target.evaluate((element) => element === document.activeElement)).toBe(true);
suite.define(() =>
  it.each([1280, 390])(
    "validates, cancels, applies, and reuses custom snoozes at width %s",
    (width) =>
      suite.withPage(
        {
          viewport: { width, height: 900 },
          colorScheme: "dark",
          timezoneId: "America/New_York",
        },
        async ({ page }) => {
          const key = "agent:main:release-notes";
          const otherKey = "agent:main:docs";
          const gateway = await installMockGateway(page, {
            sessionKey: key,
            sessions: [
              sessionRow(key, "Prepare release notes", Date.now()),
              sessionRow(otherKey, "Review documentation", Date.now() - 1000),
            ],
          });
          await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
          if (width === 390) {
            await page
              .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
              .first()
              .click();
            await waitForMobileSidebarDrawerOpen(page);
          }
          const openSnooze = async (sessionKey: string) => {
            const selector = `.sidebar-session-content [data-session-key="${sessionKey}"] .sidebar-recent-session__link`;
            await page.locator(selector).click({ button: "right" });
            if (width === 390) {
              await page.getByRole("menuitem", { name: "Snooze", exact: true }).click();
            } else {
              await openSessionMenuSubmenu(page, "Snooze");
            }
          };
          await openSnooze(key);
          const chooser = page.getByRole("menuitem", { name: "Choose another time", exact: true });
          await chooser.waitFor();
          await chooser.click();
          const picker = page.getByRole("dialog", { name: "Choose another time", exact: true });
          const field = picker.getByLabel("Date and time", { exact: true });
          await field.waitFor();
          await expectFocus(field);
          await field.fill("2020-01-01T09:00");
          await field.press("Enter");
          await picker.getByRole("alert").waitFor();
          expect(
            (await gateway.getRequests("sessions.patch")).filter(
              (r) => r.params && typeof r.params === "object" && "snoozedUntil" in r.params,
            ),
          ).toHaveLength(0);
          await field.press("Escape");
          await picker.waitFor({ state: "hidden" });
          await expectFocus(chooser);
          await chooser.click();
          await picker.getByRole("button", { name: "Cancel", exact: true }).click();
          await picker.waitFor({ state: "hidden" });
          await chooser.click();
          const value = await page.evaluate(() => {
            const date = new Date(Date.now() + 86_400_000);
            date.setHours(10, 30, 0, 0);
            const pad = (n: number) => String(n).padStart(2, "0");
            return {
              input: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T10:30`,
              timestamp: date.getTime(),
            };
          });
          const waitForSnooze = (sessionKey: string) =>
            waitForPatch(
              gateway,
              (p) => p.key === sessionKey && p.snoozedUntil === value.timestamp,
            );
          await field.fill(value.input);
          await field.press("Tab");
          await expectFocus(picker.getByRole("button", { name: "Cancel", exact: true }));
          await page.keyboard.press("Tab");
          await page.keyboard.press("Enter");
          const patch = await waitForSnooze(key);
          expect(patch.params).toMatchObject({
            key,
            agentId: "main",
            expectedSessionId: "session:" + key,
            snoozedUntil: value.timestamp,
          });
          await page.getByRole("button", { name: "Undo", exact: true }).waitFor();
          await openSnooze(otherKey);
          const custom = page.getByRole("menuitem", { name: /^Custom · / });
          await custom.waitFor();
          const menuRows = await chooser.evaluate((element) =>
            [...element.parentElement!.children]
              .filter((item) => item.matches('[role^="menuitem"]'))
              .map((item) => item.textContent?.trim()),
          );
          expect(menuRows.slice(-2)).toEqual([
            expect.stringMatching(/^Custom · /),
            "Choose another time",
          ]);
          expect(menuRows.filter((label) => label?.startsWith("Custom · "))).toHaveLength(1);
          expect(await custom.textContent()).toContain("10:30 AM");
          await custom.click();
          await waitForSnooze(otherKey);
        },
      ),
  ),
);
