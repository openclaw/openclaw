import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "main terminal page" });

suite.define(() => {
  it.each([
    { reason: "disabled", terminalEnabled: false, operatorScopes: ["operator.admin"] },
    { reason: "non-admin", terminalEnabled: true, operatorScopes: ["operator.read"] },
  ])("shows recovery when the terminal is $reason", async (scenario) => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, scenario);
      await page.goto(`${suite.server.baseUrl}terminal`);
      await waitForControlUiGatewayReady(page);
      await page.locator("openclaw-terminal-page").waitFor();
      const artifactDir = createControlUiE2eArtifactDir(`terminal-page-${scenario.reason}`);
      await page.screenshot({ path: path.join(artifactDir, "unavailable.png") });

      const content = page.locator("openclaw-terminal-page");
      await content.getByText("The terminal is not available on this gateway.").waitFor();
      expect(await gateway.getRequests("terminal.open")).toHaveLength(0);
      await content.getByRole("button", { name: "New session", exact: true }).click();
      await page.waitForURL(`${suite.server.baseUrl}new`);
      await page.locator(".agent-chat__composer-combobox textarea").waitFor();
    });
  });
});
