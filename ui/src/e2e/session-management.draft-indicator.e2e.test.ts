import { expect, it } from "vitest";
import type { ChatPaneElement } from "../pages/chat/route-draft-focus-handoff.ts";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  controlUiSessionPath,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { waitForSettledFormControls } from "./settle.test-support.ts";
import { openHomeFullPage } from "./sidebar-navigation.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("keeps the browser-local draft pencil visible on active Home beside activity", async () => {
    const mainKey = "agent:main:main";
    const secondKey = "agent:main:draft-second";
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow(mainKey, "Main", 2, {
            hasActiveRun: true,
            startedAt: 1,
            status: "running",
          }),
          sessionRow(secondKey, "Draft second", 1),
        ]),
      },
      sessionKey: mainKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, mainKey));
      const homeRow = page.locator(".sidebar-footer-bar__home");
      const secondRow = page.locator(`[data-session-key="${secondKey}"]`);
      const composer = page.locator(
        'openclaw-chat-pane[aria-hidden="false"] .agent-chat__composer-combobox > textarea',
      );
      await homeRow.waitFor({ state: "visible", timeout: 10_000 });
      await secondRow.waitFor({ state: "visible" });
      await composer.waitFor({ state: "visible" });
      await captureUiProof(suite, page, "draft-indicator-before.png");

      const homeBox = await homeRow.boundingBox();
      const restingActivity = await homeRow.getByRole("img", { name: "Active run" }).boundingBox();
      await composer.fill("Keep this unsent");
      const activity = homeRow.getByRole("img", { name: "Active run" });
      const draft = homeRow.getByRole("img", { name: "Unsent draft" });
      await activity.waitFor();
      await draft.waitFor();
      const activityBox = await activity.boundingBox();
      const draftBox = await draft.boundingBox();
      if (!activityBox || !draftBox || !homeBox || !restingActivity) {
        throw new Error("expected activity and draft icon bounds");
      }
      // The compact badge overlays the corner, not the centered run glyph.
      expect(activityBox.x + activityBox.width / 2).toBeCloseTo(
        restingActivity.x + restingActivity.width / 2,
        1,
      );
      expect(activityBox.y + activityBox.height / 2).toBeCloseTo(
        restingActivity.y + restingActivity.height / 2,
        1,
      );
      expect(draftBox.x).toBeGreaterThanOrEqual(homeBox.x);
      expect(draftBox.x + draftBox.width).toBeLessThanOrEqual(homeBox.x + homeBox.width);
      expect(draftBox.y + draftBox.height).toBeLessThanOrEqual(homeBox.y + homeBox.height);
      expect(
        draftBox.x > activityBox.x + activityBox.width / 2 ||
          draftBox.y > activityBox.y + activityBox.height / 2,
      ).toBe(true);
      await captureUiProof(suite, page, "draft-indicator-active.png");

      await secondRow.getByRole("link").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(secondKey));
      await draft.waitFor();

      await openHomeFullPage(page);
      await waitForControlUiRoute(page, {
        pathname: controlUiSessionPath(mainKey),
        routeId: "chat",
      });
      await draft.waitFor();
      const presentedPanes = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      await expect
        .poll(() =>
          presentedPanes.evaluateAll((panes) =>
            panes.map((pane) => (pane as ChatPaneElement).sessionKey),
          ),
        )
        .toEqual([mainKey]);

      await waitForSettledFormControls(page, [{ locator: composer, value: "Keep this unsent" }]);
      await composer.fill("");
      await waitForSettledFormControls(page, [{ locator: composer, value: "" }]);
      await expect.poll(() => draft.count()).toBe(0);
      // Opening Home collapses the desktop list while keeping the rail available.
      await page
        .locator(".sidebar-rail")
        .getByRole("button", { name: "Sessions", exact: true })
        .click();
      await secondRow.getByRole("link").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(secondKey));
      await expect.poll(() => draft.count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
