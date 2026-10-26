import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { getInitialHistoryRequests } from "./chat-initial-history.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session link reconnect" });
const sourceKey = "agent:main:main";
const destinationKey = "agent:main:dashboard:12345678-1111-4222-8333-abcdefabcdef";
const destinationText = "The linked conversation recovered after reconnect.";
const destinationPath = "/chat/main/linked-conversation-12345678";
const resolutionMatch = { shortId: "12345678", agentId: "main" };
const destinationMatch = { sessionKey: destinationKey };
const transcript = (content: string) => ({ messages: [{ role: "assistant", content }] });

suite.define(() => {
  it.each([false, true])(
    "recovers an interrupted session-link open while respecting newer navigation (%s)",
    async (navigateAway) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: sourceKey,
          sessions: [createControlUiSessionRow(sourceKey, "Source conversation", 1)],
          sessionTranscripts: {
            [sourceKey]: transcript(`Open [Linked conversation](${destinationPath}).`),
            [destinationKey]: transcript(destinationText),
          },
          methodResponses: {
            "sessions.resolve": {
              cases: [
                {
                  match: resolutionMatch,
                  response: {
                    ok: true,
                    key: destinationKey,
                    agentId: "main",
                    displayName: "Linked conversation",
                    boardFace: "chat",
                  },
                },
              ],
            },
          },
        });
        const requests = gateway.getRequests;
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sourceKey));
        const link = page.locator(
          `.chat-thread a.markdown-session-link[href="${destinationPath}"]`,
        );
        // Settle title decoration before deferring the separate navigation lookup.
        await link
          .and(page.locator(`[data-session-key="${destinationKey}"]`))
          .waitFor({ state: "visible" });
        await page.locator('openclaw-app-sidebar [data-navigation-view="pages"]').click();
        const activity = page.locator('openclaw-app-sidebar a[href="/activity"]');
        await activity.waitFor({ state: "visible" });
        const initialHistoryLength = await page.evaluate(() => history.length);
        const initialTitleResolutions = (await requests("sessions.resolve", resolutionMatch))
          .length;
        await gateway.deferNext("sessions.resolve", resolutionMatch);
        await link.click();
        await gateway.waitForRequest("sessions.resolve", {
          match: resolutionMatch,
          after: initialTitleResolutions,
        });
        expect(await getInitialHistoryRequests(gateway, destinationKey)).toEqual([]);

        // Hold the new hello so navigation can change while the old route is interrupted.
        await gateway.deferNext("connect");
        const previousConnects = (await requests("connect")).length;
        await gateway.closeLatest(4000, "session subscription recovery failed");
        await gateway.waitForRequest("connect", { after: previousConnects });
        if (navigateAway) {
          await activity.click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/activity");
        }
        await gateway.resolveDeferred("connect");
        await waitForControlUiGatewayReady(page);
        // A response belonging to the retired socket must not restore the abandoned route.
        await gateway.resolveDeferred("sessions.resolve");

        if (navigateAway) {
          await page.locator("openclaw-activity-page").waitFor({ state: "visible" });
        } else {
          await page
            .locator('openclaw-chat-pane[aria-hidden="false"]')
            .getByText(destinationText, { exact: true })
            .waitFor({ state: "visible" });
        }
        expect(await requests("chat.history", destinationMatch)).toEqual([]);
        expect(new URL(page.url()).pathname).toBe(navigateAway ? "/activity" : destinationPath);
        expect(await page.evaluate(() => history.length)).toBe(
          initialHistoryLength + (navigateAway ? 2 : 1),
        );
        expect(await requests("sessions.resolve", resolutionMatch)).toHaveLength(
          initialTitleResolutions + (navigateAway ? 1 : 2),
        );
        expect(await page.locator(".lazy-view-error").count()).toBe(0);
        expect(await getInitialHistoryRequests(gateway, destinationKey)).toHaveLength(
          navigateAway ? 0 : 1,
        );
      });
    },
  );
});
