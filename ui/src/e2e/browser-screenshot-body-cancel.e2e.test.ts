import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI browser screenshot failed-body E2E",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("authenticates screenshot media and presents its HTTP failure", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.removeItem("openclaw.browser.panel.v1");
      });
      let mediaRequest: { authorization: string; source: string | null } | null = null;
      await page.route("**/__openclaw__/assistant-media**", (route) => {
        const request = route.request();
        mediaRequest = {
          authorization: request.headers().authorization ?? "",
          source: new URL(request.url()).searchParams.get("source"),
        };
        return route.fulfill({
          body: "screenshot unavailable",
          contentType: "text/plain; charset=utf-8",
          status: 404,
        });
      });
      const target = { targetId: "target-1", url: "https://example.test/" };
      const responseCase = (method: string, requestPath: string, response: unknown) => ({
        match: { method, path: requestPath },
        response,
      });
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "browser.request"],
        methodResponses: {
          "browser.request": {
            cases: [
              responseCase("GET", "/tabs", {
                running: true,
                tabs: [{ ...target, tabId: "t1", title: "Example" }],
              }),
              responseCase("POST", "/screenshot", { ...target, path: "/proof/missing.png" }),
            ],
          },
        },
      });

      expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
      await openChatSidePanelType(page, "Files");
      await openChatSidePanelType(page, "Browser");

      const panel = page.locator("section.bp");
      await panel
        .getByRole("status")
        .getByText("Browser request failed: Screenshot fetch failed (404).", { exact: true })
        .waitFor();
      expect(mediaRequest).toEqual({
        authorization: "Bearer e2e-device-token",
        source: "/proof/missing.png",
      });
    });
  });
});
