import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Composer reverse Tab" });

suite.define(() => {
  it("leaves mention suggestions without choosing a recipient on Shift+Tab", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        presenceUsers: [
          {
            self: true,
            id: "demo-viewer",
            identity: { type: "profile", id: "demo-viewer" },
            name: "Demo viewer",
          },
        ],
        methodResponses: {
          "users.mentionable": {
            users: [
              {
                profileId: "00000003-1111-4111-8111-000000000103",
                displayName: "Casey Vale",
                online: true,
              },
            ],
            truncated: false,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const textarea = page.locator(".agent-chat__composer-combobox > textarea");
      await textarea.waitFor();
      await textarea.focus();
      await page.keyboard.press("Shift+Tab");
      const previous = await page.evaluateHandle(() => document.activeElement);
      expect(await page.evaluate((element) => element !== document.body, previous)).toBe(true);
      await textarea.pressSequentially("@Casey");
      const menu = page.getByRole("listbox", { name: "Mention a person" });
      await menu.getByRole("option", { name: "Casey Vale Online" }).waitFor();
      await page.keyboard.press("Shift+Tab");
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const surface = page.locator(".agent-chat__composer-shell");
        const frame = await takeControlUiScreenshotFrame(page, surface, [textarea], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "reverse-tab.png"), frame.png);
      }
      expect(await textarea.inputValue()).toBe("@Casey");
      expect(await page.evaluate((element) => element === document.activeElement, previous)).toBe(
        true,
      );
      await previous.dispose();
      expect(await page.locator(".composer-context-strip__people").count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });
});
