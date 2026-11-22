import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { nativeAuth, terminalSession } from "./workspace-terminal.test-support.ts";

const suite = createControlUiE2eSuite({ name: "main terminal page" });

suite.define(() => {
  it("returns to the sessions button on a phone and keeps the desktop picker on resize", async () => {
    await suite.withPage(
      { serviceWorkers: "block", viewport: { width: 390, height: 844 } },
      async ({ page }) => {
        const current = terminalSession("workspace", {
          title: "Workspace",
          cwd: "/workspace/site",
        });
        const previewName = "Preview · international release documentation · German";
        const other = terminalSession("preview", { title: previewName, cwd: "/workspace/preview" });
        const gateway = await installMockGateway(page, {
          terminalEnabled: true,
          featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
          methodResponses: {
            "terminal.open": current,
            "terminal.list": {
              sessions: [
                { ...current, attached: true, createdAtMs: 1 },
                { ...other, attached: false, createdAtMs: 2 },
              ],
            },
            "terminal.attach": { ...other, buffer: "Preview ready.\r\n", seq: 16 },
          },
        });
        await page.goto(`${suite.server.baseUrl}terminal`);
        const terminal = page.locator("openclaw-terminal-page");
        await gateway.waitForRequest("terminal.open");
        const sessions = terminal.getByRole("button", { name: "Terminal sessions", exact: true });
        const picker = terminal.getByRole("region", { name: "Terminal sessions" });
        const back = picker.getByRole("button", { name: "Back", exact: true });
        await sessions.click();
        const name = picker.getByText(previewName, { exact: true });
        await name.waitFor();
        await page.evaluate(() => document.fonts.ready.then(() => {}));
        expect(
          await name.evaluate((label) => {
            const text = document.createRange();
            text.selectNodeContents(label);
            const bounds = label.getBoundingClientRect();
            return [...text.getClientRects()].every(
              (line) => line.left >= bounds.left - 1 && line.right <= bounds.right + 1,
            );
          }),
          "the distinguishing end of the terminal title stays inside the picker row",
        ).toBe(true);
        await page.keyboard.press("Escape");
        expect(await picker.isVisible()).toBe(false);
        expect(await sessions.evaluate((el) => el === document.activeElement)).toBe(true);
        await sessions.click();
        await back.click();
        expect(await sessions.evaluate((el) => el === document.activeElement)).toBe(true);
        await sessions.click();
        await picker.getByRole("button", { name: /Preview/ }).click();
        expect((await gateway.waitForRequest("terminal.attach")).params).toMatchObject({
          sessionId: other.sessionId,
        });
        await terminal.getByRole("tab", { name: previewName, selected: true }).waitFor();
        expect(await picker.isVisible()).toBe(false);
        await page.setViewportSize({ width: 1440, height: 900 });
        await sessions.click();
        await picker.locator("summary").waitFor();
        expect(await back.count()).toBe(0);
        expect(await gateway.getRequests("terminal.input")).toHaveLength(0);
      },
    );
  });
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
        const content = page.locator("openclaw-terminal-page");
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
