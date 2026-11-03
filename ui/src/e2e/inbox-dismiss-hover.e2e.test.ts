import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Inbox dismiss hover",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
});

suite.define(() => {
  it("keeps the dismiss label accessible without a hover tooltip or background", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" },
      async ({ page }) => {
        await installMockGateway(page, {
          presenceUsers: [
            {
              self: true,
              id: "viewer",
              identity: { type: "profile", id: "viewer" },
              name: "Viewer",
            },
          ],
          featureMethods: [...defaultControlUiFeatureMethods, "mentions.list", "mentions.dismiss"],
          methodResponses: {
            "mentions.list": {
              gatewayInstanceId: "e2e-gateway-boot",
              revision: 1,
              items: [
                {
                  id: "hover-mention",
                  senderProfileId: "riley",
                  senderLabel: "Riley",
                  sessionKey: "agent:main:main",
                  agentId: "main",
                  sessionTitle: "Review release checklist",
                  messageId: "message-1",
                  createdAt: 1_000,
                  expiresAt: 10_000,
                },
              ],
            },
          },
        });
        await page.goto(suite.server.baseUrl + "activity");
        await page.locator(".sidebar-issues-button:visible").click();
        const row = page.locator('[data-mention-id="hover-mention"]');
        await row.waitFor();
        await row.hover();
        const dismiss = row.getByRole("button", {
          name: "Dismiss Review release checklist",
          exact: true,
        });
        const restingColor = await dismiss.evaluate((element) => getComputedStyle(element).color);
        await dismiss.hover();
        // The global title-tooltip delay must elapse before checking the rendered overlay.
        await page.waitForTimeout(1_200);
        await page.screenshot({ path: suite.artifactDir + "/dismiss-hover.png" });
        expect(await dismiss.getAttribute("aria-label")).toBe("Dismiss Review release checklist");
        expect(await dismiss.getAttribute("title")).toBeNull();
        expect(await page.getByRole("tooltip").count()).toBe(0);
        expect(await dismiss.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
          "rgba(0, 0, 0, 0)",
        );
        expect(await dismiss.evaluate((element) => getComputedStyle(element).color)).not.toBe(
          restingColor,
        );
      },
    );
  });
});
