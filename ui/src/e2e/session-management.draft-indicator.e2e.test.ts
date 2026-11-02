import { expect, it } from "vitest";
import type { ChatPaneElement } from "../pages/chat/chat-pane-elements.ts";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";
import { waitForSettledFormControls } from "./settle.test-support.ts";
import { openHomeFullPage } from "./sidebar-navigation.test-support.ts";

const suite = support.createSessionManagementE2eSuite();

suite.define(() =>
  it("keeps the browser-local draft pencil visible on active Home beside activity", () =>
    ui.withSessionPage(
      suite,
      async (page) => {
        const mainKey = "agent:main:main";
        const secondKey = "agent:main:draft-second";
        const activeRun = { hasActiveRun: true, startedAt: 1, status: "running" };
        await ui.installSessionRows(
          page,
          [sessionRow(mainKey, "Main", 2, activeRun), sessionRow(secondKey, "Draft second", 1)],
          { sessionKey: mainKey },
        );
        await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, mainKey));
        const homeRow = page.locator(".sidebar-footer-bar__home");
        const secondRow = page.locator(`[data-session-key="${secondKey}"]`);
        const composer = page.locator(
          'openclaw-chat-pane[aria-hidden="false"] .agent-chat__composer-combobox > textarea',
        );
        await homeRow.waitFor({ state: "visible", timeout: 10_000 });
        await secondRow.waitFor({ state: "visible" });
        await composer.waitFor({ state: "visible" });
        await support.captureUiProof(suite, page, "draft-indicator-before.png");

        const homeBox = await ui.bounds(homeRow);
        const restingActivity = await ui.bounds(homeRow.getByRole("img", { name: "Active run" }));
        await composer.fill("Keep this unsent");
        const activity = homeRow.getByRole("img", { name: "Active run" });
        const draft = homeRow.getByRole("img", { name: "Unsent draft" });
        await activity.waitFor();
        await draft.waitFor();
        const activityBox = await ui.bounds(activity);
        const draftBox = await ui.bounds(draft);
        // The compact badge overlays the corner, not the centered run glyph.
        expect(ui.centerX(activityBox)).toBeCloseTo(ui.centerX(restingActivity), 1);
        expect(ui.centerY(activityBox)).toBeCloseTo(ui.centerY(restingActivity), 1);
        expect(draftBox.x).toBeGreaterThanOrEqual(homeBox.x);
        expect(ui.right(draftBox)).toBeLessThanOrEqual(ui.right(homeBox));
        expect(draftBox.y + draftBox.height).toBeLessThanOrEqual(homeBox.y + homeBox.height);
        expect(
          draftBox.x > activityBox.x + activityBox.width / 2 ||
            draftBox.y > activityBox.y + activityBox.height / 2,
        ).toBe(true);
        await support.captureUiProof(suite, page, "draft-indicator-active.png");

        await secondRow.getByRole("link").click();
        await ui.expectSessionPath(page, secondKey);
        await draft.waitFor();

        await openHomeFullPage(page);
        await waitForControlUiRoute(page, {
          pathname: support.controlUiSessionPath(mainKey),
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
        await ui.button(page.locator(".sidebar-rail"), "Sessions").click();
        await secondRow.getByRole("link").click();
        await ui.expectSessionPath(page, secondKey);
        await expect.poll(() => draft.count()).toBe(0);
      },
      { colorScheme: "dark" },
    )),
);
