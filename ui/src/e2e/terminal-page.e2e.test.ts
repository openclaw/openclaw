import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { nativeAuth, terminalSession } from "./workspace-terminal.test-support.ts";

const suite = createControlUiE2eSuite({ name: "main terminal page" });

suite.define(() => {
  it("keeps the initial connection distinct from terminal unavailability", async () => {
    await suite.withPage(
      { serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await nativeAuth(page, "synthetic-terminal-auth");
        const gateway = await installMockGateway(page, {
          deferredMethods: ["connect"],
          terminalEnabled: true,
          featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
          methodResponses: {
            "terminal.list": { sessions: [] },
            "terminal.open": terminalSession("audit-cold-terminal"),
          },
        });
        await page.goto(new URL("/terminal", suite.server.baseUrl).toString());
        await gateway.waitForRequest("connect");
        const artifactDir = createControlUiE2eArtifactDir("terminal-cold-entry-audit");
        const content = page.locator("openclaw-terminal-page");
        const frame = await takeControlUiScreenshotFrame(page, content, [content], {
          animations: "disabled",
        });
        await writeFile(path.join(artifactDir, "pending.png"), frame.png);
        expect(
          await page
            .getByText("The terminal is unavailable.", { exact: true })
            .filter({ visible: true })
            .count(),
        ).toBe(0);
        expect(await gateway.getRequests("terminal.open")).toHaveLength(0);
        expect(
          await content.getByRole("button", { name: "New session", exact: true }).count(),
        ).toBe(0);
        expect(await content.locator(":scope > openclaw-panel-loading-skeleton").count()).toBe(1);
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("terminal.open");
        expect(
          await page
            .getByText("The terminal is unavailable.", { exact: true })
            .filter({ visible: true })
            .count(),
        ).toBe(0);
        expect(await gateway.getRequests("terminal.open")).toHaveLength(1);
        await page.locator("openclaw-terminal-page .tp").waitFor();
        expect(
          await page.locator("openclaw-terminal-page > openclaw-panel-loading-skeleton").count(),
        ).toBe(0);
      },
    );
  });
  it.each([
    { reason: "disabled", terminalEnabled: false, operatorScopes: ["operator.admin"] },
    { reason: "non-admin", terminalEnabled: true, operatorScopes: ["operator.read"] },
  ])("shows recovery when the terminal is $reason", async (scenario) => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        ...scenario,
        featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
      });
      await page.goto(`${suite.server.baseUrl}terminal`);
      await waitForControlUiGatewayReady(page);
      await page.locator("openclaw-terminal-page").waitFor();
      const artifactDir = createControlUiE2eArtifactDir(`terminal-page-${scenario.reason}`);
      await page.screenshot({ path: path.join(artifactDir, "unavailable.png") });

      const content = page.locator("openclaw-terminal-page");
      await content.getByText("The terminal is unavailable.").waitFor();
      expect(await gateway.getRequests("terminal.open")).toHaveLength(0);
      await content.getByRole("button", { name: "New session", exact: true }).click();
      await page.waitForURL(`${suite.server.baseUrl}new`);
      await page.locator(".agent-chat__composer-combobox textarea").waitFor();
    });
  });
});
