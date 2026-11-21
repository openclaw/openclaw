import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { terminalSession } from "./workspace-terminal.test-support.ts";

const suite = createControlUiE2eSuite({ name: "saved terminal restore retry" });

suite.define(() => {
  it("retries a failed saved-session read without opening a replacement shell", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const sessionId = "saved-terminal";
        const storageKey = "openclaw.terminal.sessions.v1:page:null";
        await page.addInitScript(
          (saved) => {
            sessionStorage.setItem(saved.storageKey, JSON.stringify([saved.sessionId]));
          },
          { storageKey, sessionId },
        );
        const session = terminalSession(sessionId);
        const gateway = await installMockGateway(page, {
          terminalEnabled: true,
          featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
          heldMethods: ["terminal.list"],
          methodResponses: {
            "terminal.list": { sessions: [{ ...session, attached: false, createdAtMs: 1 }] },
            "terminal.attach": { ...session, buffer: "Restored synthetic shell\r\n$ ", seq: 28 },
          },
        });
        await page.goto(`${suite.server.baseUrl}terminal`);
        await gateway.waitForRequest("terminal.list");
        await gateway.rejectDeferred("terminal.list", {
          code: "UNAVAILABLE",
          message: "Synthetic terminal discovery failure",
        });
        const panel = page.locator("openclaw-terminal-page openclaw-terminal-panel");
        const error = panel.locator('.tp-error[role="alert"]');
        await error.getByText(/Synthetic terminal discovery failure/).waitFor();
        const capture = async (name: string) => {
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
            return;
          }
          const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [panel], {
            animations: "disabled",
            elements: [panel],
          });
          await writeFile(path.join(suite.artifactDir, name + ".png"), frame.png);
        };
        await capture("restore-failed");
        expect(await page.evaluate((key) => sessionStorage.getItem(key), storageKey)).toBe(
          JSON.stringify([sessionId]),
        );
        expect(await gateway.getRequests("terminal.open")).toHaveLength(0);
        const retry = error.getByRole("button", { name: "Retry", exact: true });
        expect(await retry.count()).toBe(1);
        const beforeRetry = await gateway.deferNext("terminal.list");
        await retry.click();
        await gateway.waitForRequest("terminal.list", { after: beforeRetry });
        await error.waitFor({ state: "hidden" });
        expect(
          await panel
            .getByRole("button", { name: "New terminal session", exact: true })
            .isDisabled(),
        ).toBe(true);
        await gateway.resolveDeferred("terminal.list");
        expect((await gateway.waitForRequest("terminal.attach")).params).toEqual({ sessionId });
        await panel.locator(".tp-session.is-current").click();
        await panel.locator(".tp-host canvas:visible").waitFor();
        await capture("restore-recovered");
        expect(await gateway.getRequests("terminal.open")).toHaveLength(0);
        expect(await gateway.getRequests("terminal.close")).toHaveLength(0);
        expect(await error.count()).toBe(0);
      },
    );
  });
});
