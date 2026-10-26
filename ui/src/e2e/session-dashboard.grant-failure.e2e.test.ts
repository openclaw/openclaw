import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { dashboardWidget } from "./session-dashboard.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI dashboard grant failure",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:dashboard-grant-failure";

suite.define(() => {
  it("keeps a network-capability decision retryable and toasts when Allow fails", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey,
        featureMethods: ["board.get", "board.widget.grant", "chat.metadata", "chat.startup"],
        methodResponses: {
          "board.get": {
            sessionKey,
            revision: 1,
            tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
            widgets: [
              dashboardWidget("status", "Status", {
                declared: { netOrigins: ["https://api.example.com"] },
              }),
            ],
          },
          "board.widget.grant": {
            __mockError: {
              code: "UNAVAILABLE",
              message: "internal capability service detail",
            },
          },
        },
      });
      const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, storageKey }) => {
          const settings: Record<string, unknown> = JSON.parse(
            localStorage.getItem(storageKey) ?? "{}",
          );
          settings.boardSessionViews = { [key]: { activeTabId: "main" } };
          localStorage.setItem(storageKey, JSON.stringify(settings));
        },
        { key: sessionKey, storageKey: settingsKey },
      );

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      const pending = page.locator('[data-test-id="board-pending"]');
      const allow = pending.getByRole("button", { name: "Allow" });
      const reject = pending.getByRole("button", { name: "Reject" });
      await pending.waitFor();
      await gateway.deferNext("board.get", { sessionKey });
      await allow.click();

      const request = await gateway.waitForRequest("board.widget.grant");
      expect(request.params).toEqual({
        sessionKey,
        agentId: "main",
        name: "status",
        decision: "granted",
        revision: 1,
      });
      const toast = page.locator("openclaw-toast-host .app-toast");
      await toast.waitFor();
      expect(await toast.textContent()).toContain("Could not allow widget access. Try again.");
      expect(await toast.textContent()).not.toContain("internal capability service detail");
      await expect.poll(() => allow.isEnabled()).toBe(true);
      expect(await reject.isEnabled()).toBe(true);
      await pending.waitFor();
      await page.locator('[data-test-id="board-widget-action-error"]').waitFor();
    });
  });
});
