import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForSessionRosterHydration,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("keeps the page Refresh control stable during background roster reads", async () => {
    const key = "agent:main:background-refresh";
    const row = sessionRow(key, "Background refresh", 1);
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: { "sessions.list": sessionsListResponse([row]) },
        sessionKey: key,
      });
      let heldRequest = false;
      try {
        await page.goto(`${suite.server.baseUrl}sessions`);
        const refresh = page.getByRole("button", { name: "Refresh", exact: true });
        await refresh.waitFor();
        await gateway.waitForRequest("sessions.subscribe");
        await waitForSessionRosterHydration(page);

        const pageQuery = { includeUnknown: false };
        await gateway.deferNext("sessions.list", pageQuery);
        const before = (await gateway.getRequests("sessions.list", pageQuery)).length;
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: key,
          reason: "update",
          updatedAt: 2,
        });
        await gateway.waitForRequest("sessions.list", { after: before, match: pageQuery });
        heldRequest = true;
        await page.waitForTimeout(50);

        expect(await refresh.getAttribute("aria-label")).toBe("Refresh");
        expect(await refresh.isEnabled()).toBe(true);
      } finally {
        if (heldRequest) {
          await gateway.resolveDeferred("sessions.list");
        }
      }
    });
  });

  it("keeps the selected roster quiet during other agents' activity and refreshes its own changes", async () => {
    const key = "agent:main:weekly-report";
    const row = sessionRow(key, "Weekly report", 1);
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: { "sessions.list": sessionsListResponse([row]) },
        sessionKey: key,
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      const sidebar = page.locator("openclaw-app-sidebar");
      const selectedRow = sidebar.locator(`[data-session-key="${key}"]`);
      await expect.poll(() => selectedRow.textContent()).toContain("Weekly report");
      await gateway.waitForRequest("sessions.subscribe");
      // Let startup reconciliation settle before counting event-driven network traffic.
      await page.waitForTimeout(1_200);
      const before = (await gateway.getRequests("sessions.list")).length;
      for (let burst = 0; burst < 3; burst += 1) {
        for (let index = 0; index < 20; index += 1) {
          await gateway.emitGatewayEvent("sessions.changed", {
            sessionKey: `agent:research:task-${index}`,
            reason: "update",
            updatedAt: burst + 2,
          });
        }
        // Each burst crosses the real debounce window; sustained traffic must
        // not make an unrelated selected roster poll once per burst.
        await page.waitForTimeout(300);
      }
      expect((await gateway.getRequests("sessions.list")).length - before).toBe(0);
      expect(await selectedRow.textContent()).toContain("Weekly report");

      const primaryQuery = { agentId: "main", limit: 200 };
      const primaryBefore = (await gateway.getRequests("sessions.list", primaryQuery)).length;

      await gateway.setSessionsListResponse(
        sessionsListResponse([{ ...row, label: "Weekly report ready", updatedAt: 5 }]),
      );
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: key,
        reason: "update",
        updatedAt: 5,
      });
      await expect.poll(() => selectedRow.textContent()).toContain("Weekly report ready");
      await expect
        .poll(
          async () =>
            (await gateway.getRequests("sessions.list", primaryQuery)).length - primaryBefore,
        )
        .toBe(1);
    });
  });
});
