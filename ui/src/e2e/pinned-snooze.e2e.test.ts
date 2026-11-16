import { expect, it } from "vitest";
import { createControlUiMockSameOriginGatewayScript } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  openSessionMenuSubmenu,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);
suite.define(() =>
  it("hides a pinned current session on snooze and restores its pin on Undo", () =>
    suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const keys = ["agent:main:before", "agent:main:task", "agent:main:after"];
      const target = keys[1]!;
      const gateway = await installMockGateway(page, {
        sessionKey: target,
        sessions: keys.map((key, index) =>
          sessionRow(key, ["First pin", "Snooze task", "Last pin"][index]!, Date.now() - index),
        ),
      });
      await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, target));
      const pinned = page.locator('[data-session-section="pinned"] .sidebar-recent-session');
      const pinnedKeys = () =>
        pinned.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-session-key")));
      for (const key of keys) {
        await page
          .locator('[data-session-key="' + key + '"] .sidebar-recent-session__link')
          .click({ button: "right" });
        await page.getByRole("menuitem", { name: "Pin session", exact: true }).click();
      }
      await expect.poll(async () => (await pinnedKeys()).length).toBe(3);
      const savedOrder = await pinnedKeys();
      await page
        .locator('[data-session-key="' + target + '"] .sidebar-recent-session__link')
        .click({ button: "right" });
      await openSessionMenuSubmenu(page, "Snooze");
      await page.getByRole("menuitem", { name: /^In 1 hour/ }).click();
      await waitForPatch(
        gateway,
        (params) => params.key === target && typeof params.snoozedUntil === "number",
      );
      const undo = page.getByRole("button", { name: "Undo", exact: true });
      await undo.waitFor();
      await captureUiProof(suite, page, "pinned-session-snoozed.png");
      await expect.poll(pinnedKeys).toEqual(savedOrder.filter((key) => key !== target));
      expect(
        await page.locator('.sidebar-session-content [data-session-key="' + target + '"]').count(),
      ).toBe(0);
      await undo.click();
      await waitForPatch(
        gateway,
        (params) => params.key === target && params.snoozedUntil === null,
      );
      await expect.poll(pinnedKeys).toEqual(savedOrder);
    })),
);
