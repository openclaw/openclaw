import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { extractSessionBranchHeadline } from "../../../src/config/sessions/session-message-cut-content.js";
import {
  takeControlUiScreenshotFrame,
  waitForControlUiProofSurface,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionPath, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Conversation versions" });
const key = "agent:main:release-notes";
const helpText =
  "Saved copies of this conversation from rewinds or repairs. You can return to an earlier version here.";

suite.define(() => {
  it("explains versions on demand without switching, and preserves keyboard selection", async () => {
    await suite.withPage(
      { viewport: { width: 1200, height: 800 }, colorScheme: "dark" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          agentModel: "mock/mock-model",
          models: [{ id: "mock-model", name: "Mock model", provider: "mock" }],
          sessions: [{ key, label: "Release notes", kind: "direct", updatedAt: Date.now() }],
          historyMessages: [
            { id: "prompt", role: "user", content: "Help me write a short release announcement." },
            {
              id: "answer",
              role: "assistant",
              content:
                "Here is a concise draft:\n\n## A simpler way to stay organized\n\nFind your conversations faster, keep your workspace tidy, and pick up where you left off.",
            },
          ],
          methodResponses: {
            "sessions.branches.list": {
              branches: [
                {
                  leafEntryId: "current",
                  headline: extractSessionBranchHeadline({
                    type: "message",
                    message: { role: "assistant", content: "**A simpler way to stay organized**" },
                  }),
                  messageCount: 4,
                  active: true,
                },
                {
                  leafEntryId: "earlier",
                  headline: extractSessionBranchHeadline({
                    type: "message",
                    message: {
                      role: "assistant",
                      content: "## A more detailed [release announcement](https://example.com)",
                    },
                  }),
                  messageCount: 6,
                  active: false,
                },
              ],
            },
          },
        });
        await page.goto(new URL(controlUiSessionPath(key), suite.server.baseUrl).href);
        await page.getByText("Here is a concise draft:", { exact: false }).waitFor();
        const trigger = page.getByRole("button", { name: "Versions", exact: true });
        await trigger.press("Enter");
        const menu = page.locator(".chat-pane__branches-menu");
        const menuSurface = menu.locator('[part="menu"]');
        const info = menu.getByRole("button", { name: "About versions" });
        const help = page.getByRole("dialog", { name: "About versions" });
        await expect
          .poll(() => info.evaluate((element) => element === document.activeElement))
          .toBe(true);
        expect(await help.isVisible()).toBe(false);
        await waitForControlUiProofSurface(menuSurface, [info]);
        const infoIconBox = await info.locator("svg").boundingBox();
        expect(infoIconBox).not.toBeNull();
        const current = menu.locator('.chat-pane__branch-item[data-active="true"]');
        expect(await current.locator(".chat-pane__branch-headline").textContent()).toBe(
          "A simpler way to stay organized",
        );
        const textBox = await current.locator(".chat-pane__branch-copy").boundingBox();
        const checkBox = await current.locator(".chat-pane__branch-active").boundingBox();
        expect(textBox).not.toBeNull();
        expect(checkBox).not.toBeNull();
        const checkIconBox = await current.locator(".chat-pane__branch-active svg").boundingBox();
        expect(checkIconBox).not.toBeNull();
        expect(
          Math.abs(
            infoIconBox!.x + infoIconBox!.width / 2 - checkIconBox!.x - checkIconBox!.width / 2,
          ),
        ).toBeLessThanOrEqual(1);
        expect(checkBox!.x).toBeGreaterThanOrEqual(textBox!.x + textBox!.width);
        expect(
          Math.abs(checkBox!.y + checkBox!.height / 2 - textBox!.y - textBox!.height / 2),
        ).toBeLessThanOrEqual(1);
        const menuFrame = await takeControlUiScreenshotFrame(
          page,
          menuSurface,
          [info, menu.locator(".chat-pane__branch-item").last()],
          { animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, "after.png"), menuFrame.png);

        await info.press("Enter");
        await help.waitFor();
        expect((await menu.locator("wa-popover").textContent())?.trim()).toBe(helpText);
        const helpFrame = await takeControlUiScreenshotFrame(page, help, [help], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "after-help.png"), helpFrame.png);
        expect(await gateway.getRequests("sessions.branches.switch")).toHaveLength(0);

        await page.keyboard.press("Escape");
        await expect.poll(() => help.isVisible()).toBe(false);
        expect(await menuSurface.isVisible()).toBe(true);
        await info.click();
        await help.waitFor();
        await page.getByText("Here is a concise draft:", { exact: false }).click();
        await expect.poll(() => help.isVisible()).toBe(false);
        await expect.poll(() => menuSurface.isVisible()).toBe(false);
        expect(await gateway.getRequests("sessions.branches.switch")).toHaveLength(0);

        await trigger.press("Enter");
        await info.press("ArrowDown");
        await page.keyboard.press("Enter");
        const switched = await gateway.waitForRequest("sessions.branches.switch");
        expect(switched.params).toMatchObject({ leafEntryId: "earlier" });
        await expect.poll(() => menuSurface.isVisible()).toBe(false);
      },
    );
  });
});
