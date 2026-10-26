import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { terminalSession } from "./workspace-terminal.test-support.ts";

const suite = createControlUiE2eSuite({ name: "workspace panel startup" });

suite.define(() => {
  it("lazily opens a terminal and adopts its PTY on reload without reopening it", () =>
    suite.withPage(
      { serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const session = terminalSession("startup-terminal");
        const gateway = await installMockGateway(page, {
          terminalEnabled: true,
          featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
          methodResponses: {
            "terminal.list": { sessions: [] },
            "terminal.open": session,
            "environments.list": { environments: [] },
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await waitForControlUiGatewayReady(page);
        await page.locator(".new-session-page__message").waitFor();
        await page.waitForLoadState("networkidle");
        expect(
          await page.evaluate(() => customElements.get("openclaw-terminal-panel") === undefined),
        ).toBe(true);
        await page.keyboard.press("Control+Backquote");
        const root = page.locator("openclaw-terminal-panel");
        const content = root.locator(".tp-header");
        await content.waitFor();
        await root.locator(".tabstrip-tab.is-live").waitFor();
        await gateway.setMethodResponse("terminal.list", {
          sessions: [{ ...session, attached: false, owner: "conn", createdAtMs: 1 }],
        });
        await gateway.setMethodResponse("terminal.attach", { ...session, buffer: "", seq: 0 });
        await page.reload();
        await content.waitFor();
        expect((await gateway.waitForRequest("terminal.attach")).params).toEqual({
          sessionId: session.sessionId,
        });
        expect(await gateway.getRequests("terminal.open")).toHaveLength(0);
        const terminal = root.locator(".tp-host");
        await terminal.locator("canvas").waitFor();
        await terminal.click();
        await page.keyboard.type("x");
        await gateway.waitForRequest("terminal.input");
        const inputs = await gateway.getRequests("terminal.input");
        await page.keyboard.press("Control+Backquote");
        await content.waitFor({ state: "hidden" });
        expect(await gateway.getRequests("terminal.input")).toEqual(inputs);
        await page.keyboard.press("Control+Backquote");
        await content.waitFor();
      },
    ));
});
