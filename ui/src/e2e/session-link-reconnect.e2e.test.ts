import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session link reconnect" });
const sourceKey = "agent:main:main";
const destinationKey = "agent:main:dashboard:12345678-1111-4222-8333-abcdefabcdef";
const destinationText = "The linked conversation recovered after reconnect.";
const destinationPath = "/chat/main/linked-conversation-12345678";
const sidebarConfig = { ui: { prefs: { sidebarEntries: ["route:activity"] } } };

type TestApp = HTMLElement & { runtime?: { context: ApplicationContext } };

suite.define(() => {
  it.each([false, true])(
    "recovers an interrupted session-link open while respecting newer navigation (%s)",
    async (navigateAway) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: sourceKey,
          sessions: [createControlUiSessionRow(sourceKey, "Source conversation", 1)],
          sessionTranscripts: {
            [sourceKey]: {
              // URL chips need Gateway identity resolution; raw keys can already load literally.
              messages: [
                { role: "assistant", content: `Open [Linked conversation](${destinationPath}).` },
              ],
            },
            [destinationKey]: {
              messages: [{ role: "assistant", content: destinationText }],
            },
          },
          methodResponses: {
            "config.get": {
              config: sidebarConfig,
              raw: JSON.stringify(sidebarConfig),
              hash: "session-link-prefs",
              valid: true,
            },
            "sessions.resolve": {
              cases: [
                {
                  match: { shortId: "12345678", agentId: "main" },
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
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sourceKey));
        const link = page.locator(
          `.chat-thread a.markdown-session-link[href="${destinationPath}"]`,
        );
        await link.waitFor({ state: "visible" });
        await page
          .locator('openclaw-app-sidebar a[href="/activity"]')
          .waitFor({ state: "visible" });
        const initialHistoryLength = await page.evaluate(() => history.length);
        const resolutionMatch = { shortId: "12345678", agentId: "main" };
        await gateway.deferNext("sessions.resolve", resolutionMatch);
        await link.click();
        await gateway.waitForRequest("sessions.resolve", { match: resolutionMatch });
        expect(await gateway.getRequests("chat.startup", { sessionKey: destinationKey })).toEqual(
          [],
        );

        // Hold the new hello so navigation can change while the old route is interrupted.
        await gateway.deferNext("connect");
        const previousConnects = (await gateway.getRequests("connect")).length;
        await gateway.closeLatest(4000, "session subscription recovery failed");
        await gateway.waitForRequest("connect", { after: previousConnects });
        if (navigateAway) {
          await page.locator('openclaw-app-sidebar a[href="/activity"]').click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/activity");
        }
        await gateway.resolveDeferred("connect");
        await page.waitForFunction(
          () =>
            document.querySelector<TestApp>("openclaw-app")?.runtime?.context.gateway.snapshot
              .phase === "connected",
        );
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
        await expectRequestCountStable(gateway, "chat.startup", navigateAway ? 0 : 1, 500, {
          sessionKey: destinationKey,
        });
        expect(await gateway.getRequests("chat.history", { sessionKey: destinationKey })).toEqual(
          [],
        );
        expect(new URL(page.url()).pathname).toBe(navigateAway ? "/activity" : destinationPath);
        expect(await page.evaluate(() => history.length)).toBe(
          initialHistoryLength + (navigateAway ? 2 : 1),
        );
        expect(await gateway.getRequests("sessions.resolve", resolutionMatch)).toHaveLength(
          navigateAway ? 1 : 2,
        );
        expect(await page.locator(".lazy-view-error").count()).toBe(0);
      });
    },
  );
});
