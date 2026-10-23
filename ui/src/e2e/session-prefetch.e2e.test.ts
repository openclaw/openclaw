import { expect, it } from "vitest";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("opens prefetched history immediately after an unrelated roster refresh", async () => {
    const reportKey = "agent:main:weekly-report";
    const workKey = "agent:main:workspace";
    const report = createControlUiSessionRow(reportKey, "Weekly report", 1);
    const workspace = createControlUiSessionRow(workKey, "Workspace", 2);
    const reportText = "The weekly report is ready to review.";
    const reportHistory = {
      completeSnapshot: true,
      messages: [{ role: "assistant", content: reportText }],
      sessionId: report.sessionId,
    };
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: workKey,
        deferredMethods: ["chat.history"],
        methodResponses: { "sessions.list": sessionsListResponse([workspace, report]) },
        sessionTranscripts: {
          [workKey]: { messages: [{ role: "assistant", content: "Workspace ready." }] },
          [reportKey]: reportHistory,
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, workKey));
      await page.locator(".chat-thread-inner").getByText("Workspace ready.").waitFor();
      const requests = gateway.getRequests;
      expect(await requests("chat.startup")).toHaveLength(1);
      const reportTarget = { sessionKey: reportKey };
      const reportLink = page
        .locator(`openclaw-app-sidebar [data-session-key="${reportKey}"] a`)
        .first();
      await reportLink.hover();
      await expect.poll(async () => (await requests("chat.history", reportTarget)).length).toBe(1);
      expect(await requests("chat.startup")).toHaveLength(1);
      const before = (await requests("sessions.list")).length;
      await gateway.setSessionsListResponse(
        sessionsListResponse([{ ...workspace, label: "Workspace updated", updatedAt: 3 }, report]),
      );
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: workKey,
        reason: "update",
        updatedAt: 3,
      });
      await expect
        .poll(async () => (await requests("sessions.list")).length)
        .toBeGreaterThan(before);
      await expect
        .poll(() =>
          page.locator(`openclaw-app-sidebar [data-session-key="${workKey}"]`).textContent(),
        )
        .toContain("Workspace updated");
      await gateway.resolveDeferred("chat.history", reportHistory);
      const emptyReport = { messages: [], sessionId: report.sessionId };
      await gateway.setMethodResponse("chat.history", emptyReport);
      await gateway.setMethodResponse("chat.startup", emptyReport);
      await gateway.deferNext("chat.history", reportTarget);
      await gateway.deferNext("chat.startup", reportTarget);
      await reportLink.click();
      await page.locator(".chat-thread-inner").getByText(reportText).waitFor();
      expect((await requests("chat.startup", reportTarget)).length).toBeGreaterThan(0);
    });
  });
});
