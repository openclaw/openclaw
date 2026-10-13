import { expect, it } from "vitest";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Sidebar optional boot imports",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});

suite.define(() => {
  it("loads the Inbox renderer on interaction while keeping its badge available at boot", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const panelRequests: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.endsWith("/sidebar-attention-panel.runtime.ts")) {
          panelRequests.push(request.url());
        }
      });
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".agent-chat__composer-combobox textarea").waitFor();
      const inbox = page.locator(".sidebar-issues-button");
      await inbox.waitFor();
      expect(panelRequests).toHaveLength(0);
      await inbox.click();
      await page.locator(".sidebar-issues-panel").waitFor();
      expect(panelRequests).toHaveLength(1);
      expect(await inbox.getAttribute("aria-expanded")).toBe("true");
    });
  });
});
