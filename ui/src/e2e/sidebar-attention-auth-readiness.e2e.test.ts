import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({ name: "Inbox OAuth refresh readiness audit" });
suite.define(() => {
  it("keeps routine OAuth refresh out of sign-in attention while retaining a lost grant", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 1000 },
        locale: "en-US",
        colorScheme: "dark",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          presenceUsers: [{ self: true, id: "audit-reader", name: "Audit Reader" }],
          methodResponses: {
            "models.authStatus": {
              ts: Date.now(),
              providers: [
                {
                  provider: "example-pending",
                  displayName: "Refreshing account",
                  status: "expired",
                  profiles: [
                    {
                      profileId: "example-pending:account",
                      type: "oauth",
                      status: "expired",
                      reasonCode: "expired",
                    },
                  ],
                },
                {
                  provider: "example-failed",
                  displayName: "Lost grant",
                  status: "expired",
                  profiles: [
                    {
                      profileId: "example-failed:account",
                      type: "oauth",
                      status: "expired",
                      reasonCode: "refresh_failed",
                    },
                  ],
                },
              ],
            },
          },
        });
        await page.goto(suite.server.baseUrl + "new");
        await gateway.waitForRequest("models.authStatus");
        await page.locator(".sidebar-issues-button:visible").click();
        const panel = page.locator("#sidebar-issues-panel");
        const lost = panel
          .locator('[data-attention-kind="modelAuthExpired"]')
          .filter({ hasText: "Lost grant" });
        await lost.waitFor();
        const pending = panel
          .locator('[data-attention-kind="modelAuthExpired"]')
          .filter({ hasText: "Refreshing account" });
        const premature = await pending.count();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(page, panel, [lost], {
            animations: "disabled",
          });
          await writeFile(path.join(suite.artifactDir, "oauth-refresh-attention.png"), frame.png);
        }
        expect(await lost.textContent()).toContain("Sign-in required");
        expect(await gateway.getRequests("models.authLogin")).toHaveLength(0);
        expect(premature, "An admitted OAuth refresh does not require another sign-in").toBe(0);
      },
    );
  });
});
