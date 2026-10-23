import { expect, it } from "vitest";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);
const rosterMatch = { includeGlobal: true };
const listMethod = "sessions.list";

suite.define(() => {
  it("keeps one failed child load and alert until the operator retries", async () => {
    const mainKey = "agent:main:main";
    const parentKey = "agent:main:parent";
    const childKey = "agent:worker:child";
    const unrelatedKey = "agent:main:unrelated";
    const rootRows = (unrelatedLabel = "Unrelated active task") =>
      sessionsListResponse([
        sessionRow(mainKey, "Main", 30),
        sessionRow(parentKey, "Parent task", 20, { childSessions: [childKey] }),
        sessionRow(unrelatedKey, unrelatedLabel, 10),
      ]);
    const childFailure = {
      __mockError: { code: "UNAVAILABLE", message: "Child sessions unavailable" },
    };
    const childResponse = sessionsListResponse([
      sessionRow(childKey, "Recovered child", 40, { spawnedBy: parentKey }),
    ]);
    const listCases = (
      response: typeof childFailure | typeof childResponse = childFailure,
      label?: string,
    ) => ({
      cases: [{ match: { spawnedBy: parentKey }, response }, { response: rootRows(label) }],
    });
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: { [listMethod]: listCases() },
      sessionKey: mainKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, mainKey));
      const parent = page.locator(`[data-session-key="${parentKey}"]`);
      await parent.waitFor({ state: "visible", timeout: 10_000 });
      const alertMarker = await page.evaluateHandle(() => {
        const marker = { insertions: 0 };
        new MutationObserver((records) => {
          for (const node of records.flatMap((record) => [...record.addedNodes])) {
            if (node instanceof Element) {
              marker.insertions += Number(node.matches('[role="alert"]'));
              marker.insertions += node.querySelectorAll('[role="alert"]').length;
            }
          }
        }).observe(document.body, { childList: true, subtree: true });
        return marker;
      });
      await parent.locator(`[data-child-session-toggle="${parentKey}"]`).click();

      const alert = page.locator(`[data-child-session-error="${parentKey}"]`);
      await alert.waitFor({ state: "visible" });
      const mounted = await alert.elementHandle();
      const childRequestCount = async () =>
        (await gateway.getRequests(listMethod, { spawnedBy: parentKey })).length;
      const rosterRequests = () => gateway.getRequests(listMethod, rosterMatch);
      expect(await childRequestCount()).toBe(1);

      await page.clock.install();
      await pauseVirtualClock(page);
      for (let revision = 1; revision <= 3; revision += 1) {
        const unrelatedLabel = `Unrelated active task ${revision}`;
        await gateway.setMethodResponse(listMethod, listCases(childFailure, unrelatedLabel));
        const listRequests = await gateway.deferNext(listMethod, rosterMatch);
        await gateway.emitGatewayEvent("sessions.changed", {
          key: unrelatedKey,
          reason: "run",
          sessionKey: unrelatedKey,
          updatedAt: 30 + revision,
        });
        // Allow the shared refresh policy's maximum cooldown; the fixture owns response delivery.
        await page.clock.runFor(15_001);
        expect((await rosterRequests()).length).toBeGreaterThan(listRequests);
        // Exercise a slow successful refresh without leaving a mock timer behind the paused clock.
        if (revision === 1) {
          await page.clock.runFor(2_000);
        }
        await gateway.resolveDeferred(listMethod, undefined, { match: rosterMatch });
        await page.clock.runFor(50);
        await page
          .locator(`.sidebar-recent-session[data-session-key="${unrelatedKey}"]`)
          .getByText(unrelatedLabel, { exact: true })
          .waitFor();
        expect(await childRequestCount()).toBe(1);
        expect(await alert.count()).toBe(1);
        expect(await alert.evaluate((node, original) => node === original, mounted)).toBe(true);
      }
      expect(await alertMarker.evaluate((marker) => marker.insertions)).toBe(1);

      await page.clock.resume();
      await gateway.setMethodResponse(listMethod, listCases(childResponse));
      await alert.getByRole("button", { name: "Retry" }).click();
      await page.getByText("Recovered child", { exact: true }).waitFor();
      expect(await childRequestCount()).toBe(2);
      expect(await alert.count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
