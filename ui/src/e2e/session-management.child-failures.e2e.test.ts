import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);

suite.define(() => {
  it("keeps recovered conversations free of inherited child failures after reload", async () => {
    const parentKey = "agent:main:release";
    const failedKey = "agent:main:subagent:review";
    const ownFailureKey = "agent:main:needs-attention";
    const now = Date.now();
    const parent = sessionRow(parentKey, "Prepare release", now, {
      sidebarRoot: true,
      childSessions: [failedKey],
      status: "done",
      hasActiveRun: false,
    });
    const child = {
      ...sessionRow(failedKey, "Review changes", now - 60_000, {
        spawnedBy: parentKey,
        status: "failed",
        hasActiveRun: false,
        endedAt: now - 60_000,
      }),
      lastRunError: "Rate-limit recovery stopped",
    };
    const ownFailure = {
      ...sessionRow(ownFailureKey, "Connection needs attention", now - 1_000, {
        status: "failed",
        hasActiveRun: false,
        endedAt: now - 1_000,
      }),
      lastRunError: "Connection lost",
    };
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessions: [parent, child, ownFailure],
      methodResponses: {
        "sessions.list": {
          cases: [
            { match: { spawnedBy: parentKey }, response: sessionsListResponse([child]) },
            { response: sessionsListResponse([parent, child, ownFailure]) },
          ],
        },
      },
      sessionKey: parentKey,
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
      const row = page.locator(
        'openclaw-app-sidebar .sidebar-recent-session[data-session-key="' + parentKey + '"]',
      );
      await row.waitFor({ state: "visible" });
      await gateway.waitForRequest("sessions.list", { match: { spawnedBy: parentKey } });
      await page
        .locator('[data-session-key="' + ownFailureKey + '"] [data-session-attention="error"]')
        .waitFor();
      await captureUiProof(suite, page, "recovered-parent.png");
      expect(await row.locator('[data-session-attention="error"]').count()).toBe(0);
      expect(await row.getByRole("img", { name: "Failed", exact: true }).count()).toBe(0);
      expect(await page.locator('[data-session-key="' + failedKey + '"]').count()).toBe(0);

      await page.reload();
      await row.waitFor({ state: "visible" });
      expect(await row.locator('[data-session-attention="error"]').count()).toBe(0);
      expect(await row.getByRole("img", { name: "Failed", exact: true }).count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
