import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);

suite.define(() => {
  it("keeps the drag source still while promoting a nested conversation with a native pointer", async () => {
    const parentKey = "agent:main:promotion-parent";
    const childKey = "agent:main:promotion-child";
    const child = sessionRow(childKey, "Independent follow-up", 2, {
      parentSessionKey: parentKey,
      spawnedBy: parentKey,
    });
    const parent = sessionRow(parentKey, "Project discussion", 1, { childSessions: [childKey] });
    const context = await suite.browser.newContext({
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessions: [parent, child],
      sessionKey: parentKey,
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
      await page.locator('[data-child-session-toggle="' + parentKey + '"]').click();
      const row = page.locator('.sidebar-recent-session[data-session-key="' + childKey + '"]');
      await row.waitFor({ state: "visible" });
      expect(await row.getAttribute("draggable")).toBe("true");
      await page.evaluate(() => document.fonts.ready);
      const before = await row.boundingBox();
      expect(before).not.toBeNull();
      await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
      await page.mouse.down();
      await page.mouse.move(before!.x + before!.width / 2 + 12, before!.y + before!.height / 2, {
        steps: 3,
      });
      const target = page.locator("[data-session-root-drop]");
      await target.waitFor({ state: "visible" });
      // A flow insertion here cancels native Chromium drag before any drop event.
      expect(await row.boundingBox()).toEqual(before);
      const destination = await target.boundingBox();
      expect(destination).not.toBeNull();
      await page.mouse.move(
        destination!.x + destination!.width / 2,
        destination!.y + destination!.height / 2,
        { steps: 5 },
      );
      await page.mouse.up();
      const patch = await waitForPatch(
        gateway,
        (params) => params.key === childKey && params.sidebarRoot === true,
      );
      expect(requireRecord(patch.params)).toMatchObject({
        key: childKey,
        expectedSessionId: child.sessionId,
        sidebarRoot: true,
      });
    } finally {
      await page.mouse.up();
      await context.close();
    }
  });
});
