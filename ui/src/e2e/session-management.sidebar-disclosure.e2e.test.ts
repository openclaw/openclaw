import { expect, it } from "vitest";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite();
const parentKey = "agent:main:loop-parent";
const peerKey = "agent:main:loop-peer";
const firstKey = "agent:main:loop-child";
const nextKey = "agent:main:loop-next-child";
const baseTime = Date.parse("2026-11-01T12:00:00Z");
const childScope = { spawnedBy: parentKey };
const parent = sessionRow(parentKey, "Release loop", baseTime, { childSessions: [firstKey] });
const peer = sessionRow(peerKey, "Review loop", baseTime - 1_000);
const child = sessionRow(firstKey, "Check release notes", baseTime - 2_000, childScope);
const nextChild = sessionRow(nextKey, "Check package metadata", baseTime - 3_000, childScope);

suite.define(() => {
  it("keeps a background parent collapsed when its child list changes", () =>
    ui.withSessionPage(
      suite,
      async (page) => {
        const gateway = await support.installMockGateway(page, {
          sessionKey: peerKey,
          sessions: [parent, peer, child, nextChild],
          methodResponses: {
            "sessions.list": {
              cases: [
                { match: childScope, response: support.sessionsListResponse([child]) },
                { response: support.sessionsListResponse([parent, peer]) },
              ],
            },
          },
        });
        await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, peerKey));
        const toggle = page.locator(`[data-child-session-toggle="${parentKey}"]`);
        const rows = ui.sessionRows(page);
        await toggle.click();
        await rows(firstKey).waitFor({ state: "visible" });
        await toggle.click();
        await rows(firstKey).waitFor({ state: "hidden" });

        await page.clock.install();
        await pauseVirtualClock(page);
        await gateway.setMethodResponse("sessions.list", {
          cases: [
            { match: childScope, response: support.sessionsListResponse([child, nextChild]) },
            {
              response: support.sessionsListResponse([
                { ...parent, childSessions: [firstKey, nextKey] },
                peer,
              ]),
            },
          ],
        });
        await gateway.emitGatewayEvent("sessions.changed", {
          reason: "create",
          sessionKey: nextKey,
          ...childScope,
        });
        await page.clock.runFor(5_001);
        await page.clock.resume();
        await expect.poll(() => toggle.getAttribute("aria-label")).toMatch(/2 child sessions/);
        await support.captureUiProof(suite, page, "child-disclosure-after-event.png");
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        expect(await rows(firstKey).count()).toBe(0);
        await toggle.click();
        await rows(nextKey).waitFor({ state: "visible" });
      },
      { colorScheme: "dark" },
    ));
});
