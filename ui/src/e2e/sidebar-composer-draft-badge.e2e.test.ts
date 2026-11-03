import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite();

suite.define(() => {
  it("shows an unsent draft only away from its active conversation", () =>
    ui.withSessionPage(
      suite,
      async (page) => {
        const firstKey = "agent:main:draft-design";
        const secondKey = "agent:main:draft-review";
        const text = "Review the draft design before sending.";
        await ui.installSessionRows(page, [
          sessionRow(firstKey, "Draft design", 2, { model: "test-model", modelProvider: "test" }),
          sessionRow(secondKey, "Design review", 1, { model: "test-model", modelProvider: "test" }),
        ]);
        await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, firstKey));
        const firstRow = page.locator(
          '.sidebar-recent-session[data-session-key="' + firstKey + '"]',
        );
        const secondRow = page.locator(
          '.sidebar-recent-session[data-session-key="' + secondKey + '"]',
        );
        const composer = page.locator(
          'openclaw-chat-pane[aria-hidden="false"] .agent-chat__composer-combobox > textarea',
        );
        const badge = firstRow.getByRole("img", { name: "Unsent draft" });
        const capture = async (fileName: string) => {
          if (!support.captureUiProofEnabled) {
            return;
          }
          await composer.click();
          await page.mouse.move(1100, 100);
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".shell"),
            [firstRow, composer],
            { animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, fileName), frame.png);
        };
        await composer.waitFor({ state: "visible" });
        await composer.fill(text);
        await expect.poll(() => badge.count()).toBe(0);
        await capture("active-after-typing.png");
        await secondRow.locator("a.sidebar-recent-session__link").click();
        await ui.expectSessionPath(page, secondKey);
        await expect.poll(() => badge.count()).toBe(1);
        await expect.poll(() => composer.inputValue()).toBe("");
        await badge.waitFor({ state: "visible" });
        await capture("inactive-draft.png");
        await firstRow.locator("a.sidebar-recent-session__link").click();
        await ui.expectSessionPath(page, firstKey);
        await expect.poll(() => composer.inputValue()).toBe(text);
        await capture("active-draft.png");
        await expect.poll(() => badge.count()).toBe(0);
        await composer.fill("");
        await secondRow.locator("a.sidebar-recent-session__link").click();
        await ui.expectSessionPath(page, secondKey);
        await expect.poll(() => badge.count()).toBe(0);
        await firstRow.locator("a.sidebar-recent-session__link").click();
        await ui.expectSessionPath(page, firstKey);
        await expect.poll(() => composer.inputValue()).toBe("");
      },
      { viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
    ));
});
